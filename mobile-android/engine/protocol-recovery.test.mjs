import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./protocol.ts', import.meta.url));
const compiled = await build({
  entryPoints: [entry], bundle: true, write: false, format: 'iife', target: 'es2020',
  plugins: [{
    name: 'recovery-test-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /(?:device-auth|pairing-auth|secure-channel-client)$/ }, args => ({ path: args.path, namespace: 'recovery-stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'recovery-stub' }, args => {
        if (args.path.endsWith('secure-channel-client')) return { contents: 'export const BrowserSecureChannel=globalThis.MockChannel;' };
        if (args.path.endsWith('device-auth')) return { contents: `
          export const createDeviceIdentity=()=>({id:'test-client',publicKey:'test-public',privateKey:'test-private'});
          export const createDeviceAuthProof=()=>({id:'test-client',publicKey:'test-public',signature:'test-signature'});
        ` };
        return { contents: `
          export const DEVICE_KEY_AUTH_CONTEXT='test-context';
          export const parseBrowserPairingCredential=()=>({id:'test-pairing',secret:'test-secret'});
          export const browserPairingVerifier=()=>'';
          export const createBrowserPairingProof=()=>'';
        ` };
      });
    },
  }],
});
const bundle = compiled.outputFiles[0].text;

function harness({ autoSelect = false } = {}) {
  const events = [], sockets = [], channels = [], timers = new Map();
  let time = 0, nextTimer = 1, context;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    frames = [];
    constructor(url) { this.url = url; sockets.push(this); }
    send(raw) { this.frames.push(JSON.parse(raw)); }
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    server(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  }
  class Channel {
    frames = [];
    cleared = false;
    ready = false;
    constructor(options) { this.options = options; channels.push(this); }
    start() { this.started = true; return this.options.send({type:'channel.offer', deviceId:this.options.routeDeviceId}); }
    clear() { this.cleared = true; this.ready = false; }
    isReady() { return this.ready; }
    handle(frame) { if(frame.type==='channel.error')this.fail(); }
    sendFrame(frame) { if(!this.ready || this.cleared)return false;this.frames.push(frame);return true; }
    becomeReady() { this.ready = true; this.options.onReady(); }
    fail() { this.ready = false; this.options.onError(); }
    incoming(frame) { this.options.onFrame(frame); }
  }
  context = vm.createContext({
    URL, WebSocket:Socket, MockChannel:Channel,
    setTimeout(fn, delay) { const id=nextTimer++;timers.set(id,{fn,due:time+delay});return id; },
    clearTimeout(id) { timers.delete(id); },
    Native: {
      identity: () => '', saveIdentity() {},
      emit(raw) {
        const event = JSON.parse(raw);events.push(event);
        if(autoSelect && event.type==='devices' && !event.selectedDeviceId && event.devices.length) {
          const first=event.devices[0];context.selectDevice(typeof first==='string'?first:first.id);
        }
      },
    },
  });
  vm.runInContext(bundle, context);
  context.setForeground(true);
  const devices = (ids=['pc'], offline=[]) => ({
    devices:ids,
    environments:[...ids.map(id=>({id,label:id,online:true})),...offline.map(id=>({id,label:id,online:false}))],
  });
  const connect = (origin='https://relay.test/') => {
    context.connect(origin,'');const ws=sockets.at(-1);
    ws.server({type:'auth.ok',...devices()});return ws;
  };
  const advance = ms => {
    const end=time+ms;let iterations=0;
    while(true) {
      const next=[...timers].filter(([,value])=>value.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];
      if(!next)break;if(++iterations>100)throw new Error('unbounded timer loop');
      timers.delete(next[0]);time=next[1].due;next[1].fn();
    }
    time=end;
  };
  return { context,events,sockets,channels,timers,devices,connect,advance };
}

test('connector restart clears stale keys, recovers the selected route and never replays mutation requests',()=>{
  const h=harness(), ws=h.connect();h.context.selectDevice('pc');
  const old=h.channels[0];old.becomeReady();
  h.context.request('send-once','turn.start',{text:'example'});
  assert.equal(old.frames.length,1);
  ws.server({type:'presence',...h.devices([],['pc'])});
  assert.equal(old.cleared,true);
  assert.ok(h.events.some(e=>e.type==='disconnected'&&e.scope==='device'));
  h.context.request('offline-send','turn.start',{text:'not sent'});
  assert.ok(h.events.some(e=>e.type==='requestFailed'&&e.requestId==='offline-send'));
  ws.server({type:'presence',...h.devices()});
  assert.equal(h.channels.length,2);
  const recovered=h.channels[1];recovered.becomeReady();
  assert.equal(recovered.frames.length,0,'neither prior nor offline mutation may be replayed');
  h.context.request('fresh-read','session.read',{threadId:'thread'});
  assert.equal(recovered.frames[0].action,'session.read');
  const inventory=h.events.filter(e=>e.type==='devices').at(-1);
  assert.equal(inventory.selectedDeviceId,'pc');assert.equal(inventory.selectedOnline,true);
});

test('failed handshakes retry at most three times, even with repeated online presence',()=>{
  const h=harness(),ws=h.connect();h.context.selectDevice('pc');
  h.channels[0].fail();h.advance(500);assert.equal(h.channels.length,2);
  h.channels[1].fail();h.advance(1000);assert.equal(h.channels.length,3);
  h.channels[2].fail();h.advance(60000);
  for(let i=0;i<10;i++)ws.server({type:'presence',...h.devices()});
  assert.equal(h.channels.length,3);assert.equal(h.timers.size,0);
  assert.ok(h.events.some(e=>e.type==='error'&&e.scope==='device'));
  h.context.selectDevice('pc');assert.equal(h.channels.length,4,'explicit user retry resets the budget');
});

test('missing handshake responses time out with a bounded retry budget',()=>{
  const h=harness();h.connect();h.context.selectDevice('pc');h.advance(60000);
  assert.equal(h.channels.length,3);assert.equal(h.timers.size,0);
  assert.ok(h.channels.every(c=>c.cleared));
});

test('stale channel callbacks cannot render old frames or change current device readiness',()=>{
  const h=harness(),ws=h.connect();ws.server({type:'presence',...h.devices(['pc','other'])});
  h.context.selectDevice('pc');const old=h.channels[0];h.context.selectDevice('other');
  const current=h.channels[1];const before=h.events.length;
  old.becomeReady();old.fail();old.incoming({type:'response',requestId:'old'});
  assert.equal(h.events.length,before);
  current.becomeReady();current.incoming({type:'response',requestId:'new'});
  const event=h.events.at(-1);assert.equal(event.type,'frame');assert.equal(event.deviceId,'other');
  assert.equal(event.frame.requestId,'new');
});

test('same relay reconnect restores route, a different relay requires selection, old socket errors are ignored',()=>{
  const h=harness(),old=h.connect();h.context.selectDevice('pc');h.channels[0].becomeReady();
  const current=h.connect();assert.equal(h.channels.length,2);
  const before=h.events.length;old.onerror?.();old.server({type:'presence',...h.devices([],['pc'])});
  assert.equal(h.events.length,before);
  h.connect('https://different.test/');assert.equal(h.channels.length,2);
  assert.equal(h.events.filter(e=>e.type==='devices').at(-1).selectedDeviceId,'');
  const last=h.events.length;current.onerror?.();assert.equal(h.events.length,last);
});

test('cancel invalidates delayed retries and ignores late auth success',()=>{
  const h=harness(),ws=h.connect();h.context.selectDevice('pc');h.channels[0].fail();
  h.context.cancelConnection();const before=h.events.length;
  h.advance(60000);ws.server({type:'auth.ok',...h.devices()});ws.onerror?.();
  assert.equal(h.events.length,before);assert.equal(h.channels.length,1);assert.equal(h.timers.size,0);
});

test('offline registered devices are not treated as reachable and healthy presence does not rehandshake',()=>{
  const h=harness(),ws=h.connect();ws.server({type:'presence',...h.devices([],['pc'])});h.context.selectDevice('pc');
  assert.equal(h.channels.length,0);
  ws.server({type:'presence',...h.devices()});assert.equal(h.channels.length,1);h.channels[0].becomeReady();
  for(let i=0;i<10;i++)ws.server({type:'presence',...h.devices()});
  assert.equal(h.channels.length,1);
  assert.equal(h.events.filter(e=>e.type==='devices').at(-1).channelReady,true);
});

test('native startup selection from inventory does not create duplicate handshakes',()=>{
  const h=harness({autoSelect:true});h.connect();assert.equal(h.channels.length,1);
  h.channels[0].becomeReady();assert.equal(h.events.filter(e=>e.type==='ready').length,1);
});

test('relay session expiry reauthenticates with the saved device key and recovers the selected route without replay',()=>{
  const h=harness();h.context.connect('https://relay.test/','single-use-pairing');const ws=h.sockets[0];
  ws.server({type:'auth.challenge',challenge:'first'});
  assert.equal(ws.frames[0].type,'auth.enroll');
  ws.server({type:'auth.ok',...h.devices()});h.context.selectDevice('pc');
  const old=h.channels[0];old.becomeReady();h.context.request('sent','turn.start',{text:'send once'});
  ws.close(4005);
  assert.equal(old.cleared,true);
  const disconnected=h.events.filter(e=>e.type==='disconnected').at(-1);
  assert.equal(disconnected.scope,'relay');assert.equal(disconnected.code,4005);assert.equal(disconnected.retrying,true);
  const cleared=h.events.filter(e=>e.type==='devices').at(-1);
  assert.equal(cleared.relayAuthenticated,false);assert.deepEqual(cleared.devices,[]);
  assert.equal(cleared.selectedOnline,false);assert.equal(cleared.channelReady,false);
  h.advance(500);const retry=h.sockets[1];assert.equal(retry.url,ws.url);
  retry.server({type:'auth.challenge',challenge:'second'});
  assert.equal(retry.frames[0].type,'auth.device');assert.equal('pairingId' in retry.frames[0],false);
  retry.server({type:'auth.ok',...h.devices()});
  const current=h.channels[1];assert.equal(current.options.routeDeviceId,'pc');current.becomeReady();
  assert.deepEqual(current.frames,[]);
  assert.equal(h.events.filter(e=>e.type==='devices').at(-1).relayAuthenticated,true);
  h.context.request('fresh','session.read',{});assert.equal(current.frames[0].requestId,'fresh');
});

test('relay retries wait while the app is in the background, including a scheduled retry',()=>{
  const h=harness(),ws=h.connect();ws.close(1006);
  h.context.setForeground(false);h.advance(60000);assert.equal(h.sockets.length,1);
  h.context.setForeground(true);h.advance(500);assert.equal(h.sockets.length,2);
  h.context.setForeground(false);h.sockets[1].close(1006);
  const disconnected=h.events.filter(e=>e.type==='disconnected').at(-1);
  assert.equal(disconnected.retrying,false);
  h.advance(60000);assert.equal(h.sockets.length,2);
  h.context.setForeground(true);h.advance(1000);assert.equal(h.sockets.length,3);
});

test('transient relay retries back off and stop after five attempts',()=>{
  const h=harness(),ws=h.connect();ws.close(1006);
  for(const [i, delay] of [500,1000,2000,4000,8000].entries()) {
    h.advance(delay-1);assert.equal(h.sockets.length,i+1);
    h.advance(1);assert.equal(h.sockets.length,i+2);h.sockets.at(-1).close(1006);
  }
  h.advance(60000);assert.equal(h.sockets.length,6);assert.equal(h.timers.size,0);
  assert.equal(h.events.filter(e=>e.type==='disconnected').at(-1).retrying,false);
});

test('authentication and approval failures, incomplete pairing, and explicit cancellation never retry',()=>{
  for(const code of [4001,4003,4403,4406,4407,4409,4429]) {
    const h=harness(),ws=h.connect();ws.close(code);h.advance(60000);
    assert.equal(h.sockets.length,1,`close ${code} must not retry`);
  }
  const pairing=harness();pairing.context.connect('https://relay.test/','pending-pairing');
  pairing.sockets[0].close(1006);pairing.advance(60000);assert.equal(pairing.sockets.length,1);
  const cancelled=harness();cancelled.connect().close(4005);cancelled.context.cancelConnection();
  cancelled.advance(60000);assert.equal(cancelled.sockets.length,1);
});

test('selecting a stale device during a relay outage is distinct from a confirmed offline device',()=>{
  const h=harness(),ws=h.connect();ws.close(1006);h.context.selectDevice('pc');
  assert.equal(h.events.at(-1).scope,'relay');assert.doesNotMatch(h.events.at(-1).message,/电脑尚未在线/);
  h.advance(500);h.sockets.at(-1).server({type:'auth.ok',...h.devices([],['pc'])});
  h.context.selectDevice('pc');assert.equal(h.events.at(-1).scope,'device');
  assert.match(h.events.at(-1).message,/电脑尚未在线/);
});
