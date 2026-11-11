import { createDeviceIdentity, createDeviceAuthProof } from '../../src/shared/device-auth';
import {
  parseBrowserPairingCredential, browserPairingVerifier, createBrowserPairingProof,
  DEVICE_KEY_AUTH_CONTEXT,
} from '../../src/shared/pairing-auth';
import { BrowserSecureChannel } from '../../web/src/secure-channel-client';

declare const Native: { emit: (s: string) => void; identity: () => string; saveIdentity: (s: string) => void };
type Frame = Record<string, any>;
const emit = (type: string, data: Frame = {}) => Native.emit(JSON.stringify({ type, ...data }));
const MAX_CHANNEL_ATTEMPTS = 3;
const CHANNEL_TIMEOUT_MS = 8_000;
const MAX_RELAY_ATTEMPTS = 5;
const TRANSIENT_RELAY_CLOSE_CODES = new Set([1000, 1001, 1006, 1011, 1012, 1013, 1014, 4005]);
let socket: WebSocket | null = null;
let channel: BrowserSecureChannel | null = null;
let identity: ReturnType<typeof createDeviceIdentity>;
let route = '', relayOrigin = '', epoch = 0, channelEpoch = 0;
let authenticated = false, channelAttempts = 0;
let devices: any[] = [], onlineDevices = new Set<string>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
let foreground = false, relayRecoveryAllowed = false, relayRetryPending = false, relayAttempts = 0;
let relayTarget: URL | null = null;
let relayRetryTimer: ReturnType<typeof setTimeout> | null = null;
try {
  const saved = JSON.parse(Native.identity());
  identity = createDeviceIdentity(saved.privateKey);
} catch {
  identity = createDeviceIdentity();
  Native.saveIdentity(JSON.stringify(identity));
}

function clearTimers() {
  if (retryTimer !== null) clearTimeout(retryTimer);
  if (handshakeTimer !== null) clearTimeout(handshakeTimer);
  retryTimer = handshakeTimer = null;
}

function clearChannel() {
  ++channelEpoch;
  clearTimers();
  channel?.clear();
  channel = null;
}

function send(frame: Frame) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try { socket.send(JSON.stringify(frame)); return true; } catch { return false; }
}

function isRelayReady() {
  return authenticated && socket?.readyState === WebSocket.OPEN;
}

function canConnectDevice() {
  return isRelayReady() && Boolean(route) && onlineDevices.has(route);
}

function emitInventory() {
  emit('devices', {
    devices,
    selectedDeviceId: route,
    selectedOnline: Boolean(route) && onlineDevices.has(route),
    channelReady: channel?.isReady() === true,
    relayAuthenticated: isRelayReady(),
  });
}

function channelFailed(expected: BrowserSecureChannel, message: string) {
  if (channel !== expected) return;
  clearChannel();
  emit('disconnected', { scope: 'device', selectedDeviceId: route, message });
  if (!canConnectDevice() || channelAttempts >= MAX_CHANNEL_ATTEMPTS) {
    emit('error', {
      scope: 'device', selectedDeviceId: route,
      message: canConnectDevice() ? '安全连接未恢复，请重新选择电脑；未确认的消息不会自动重发' : message,
    });
    return;
  }
  const connection = epoch, selected = route;
  emit('status', { scope: 'device', message: '正在恢复电脑的安全连接…' });
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (connection === epoch && selected === route && canConnectDevice()) startChannel();
  }, channelAttempts * 500);
}

function startChannel() {
  if (!canConnectDevice() || channel || channelAttempts >= MAX_CHANNEL_ATTEMPTS) return;
  clearTimers();
  const connection = epoch, selected = route, generation = ++channelEpoch;
  ++channelAttempts;
  const current = () => connection === epoch && generation === channelEpoch && selected === route && channel === next;
  const next = new BrowserSecureChannel({
    identity, routeDeviceId: selected,
    send: frame => current() && send(frame),
    onFrame: frame => {
      if (current()) emit('frame', { frame, deviceId: selected });
    },
    onReady: () => {
      if (!current()) return;
      if (handshakeTimer !== null) clearTimeout(handshakeTimer);
      handshakeTimer = null;
      channelAttempts = 0;
      emit('ready', { deviceId: selected });
    },
    onError: () => {
      if (current()) channelFailed(next, '电脑的安全连接已失效，正在重新验证');
    },
  });
  channel = next;
  emit('status', { scope: 'device', message: '正在建立电脑的安全连接…' });
  try {
    if (!next.start()) {
      if (current()) channelFailed(next, '无法发送安全连接请求');
      return;
    }
  } catch {
    if (current()) channelFailed(next, '安全连接初始化失败');
    return;
  }
  if (current() && !next.isReady()) {
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (current()) channelFailed(next, '电脑的安全连接超时');
    }, CHANNEL_TIMEOUT_MS);
  }
}

function updatePresence(message: Frame) {
  const previousOnline = Boolean(route) && onlineDevices.has(route);
  devices = Array.isArray(message.environments) ? message.environments : (Array.isArray(message.devices) ? message.devices : []);
  // The relay's devices array contains ONLINE routes; environments also includes offline entries.
  onlineDevices = new Set(Array.isArray(message.devices)
    ? message.devices.filter((id: unknown): id is string => typeof id === 'string')
    : devices.filter(item => typeof item === 'string' || item?.online === true)
      .map(item => typeof item === 'string' ? item : item.id));
  const online = Boolean(route) && onlineDevices.has(route);
  if (route && !online) {
    const hadChannel = channel !== null || retryTimer !== null;
    clearChannel();
    channelAttempts = 0;
    if (hadChannel || previousOnline) emit('disconnected', {
      scope: 'device', selectedDeviceId: route,
      message: '电脑暂时离线，等待重新连接；未确认的消息不会自动重发',
    });
  } else if (route && online && !previousOnline) {
    // A connector restart loses its channel keys. Always negotiate fresh keys after reappearance.
    clearChannel();
    channelAttempts = 0;
  }
  emitInventory();
  if (online && !channel && retryTimer === null) startChannel();
}

function clearRelayRetryTimer() {
  if (relayRetryTimer !== null) clearTimeout(relayRetryTimer);
  relayRetryTimer = null;
}

function scheduleRelayRetry() {
  if (!foreground || !relayRetryPending || relayRetryTimer !== null || !relayTarget) return;
  const target = relayTarget, connection = epoch;
  const delay = 500 * 2 ** relayAttempts;
  relayRetryTimer = setTimeout(() => {
    relayRetryTimer = null;
    if (!foreground || !relayRetryPending || connection !== epoch || relayTarget !== target) return;
    relayRetryPending = false;
    ++relayAttempts;
    openRelay(target, null, true);
  }, delay);
}

function openRelay(target: URL, pairing: ReturnType<typeof parseBrowserPairingCredential> | null, retrying: boolean) {
  const connection = ++epoch;
  clearChannel();
  const previous = socket;
  socket = null;
  previous?.close();
  authenticated = false;
  channelAttempts = 0;
  onlineDevices.clear();
  devices = [];
  if (target.origin !== relayOrigin) route = '';
  relayOrigin = target.origin;
  const currentSocket = new WebSocket('wss://' + target.host + '/ws');
  socket = currentSocket;
  emit('status', { scope: 'relay', message: retrying ? '正在重新连接服务器…' : '连接中' });
  emitInventory();
  currentSocket.onmessage = event => {
    if (connection !== epoch || socket !== currentSocket) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'auth.challenge') {
        let proof = DEVICE_KEY_AUTH_CONTEXT;
        if (pairing) proof = createBrowserPairingProof({
          verifier: browserPairingVerifier(pairing.secret), challenge: message.challenge,
          pairingId: pairing.id, deviceId: identity.id, publicKey: identity.publicKey,
        });
        send({
          type: pairing ? 'auth.enroll' : 'auth.device', role: 'client',
          ...(pairing ? { pairingId: pairing.id, proof } : {}),
          device: createDeviceAuthProof(identity, { challenge: message.challenge, role: 'client', authProof: proof }, 'Android Native'),
          protocol: message.protocol,
        });
      } else if (message.type === 'auth.ok') {
        authenticated = true;
        pairing = null;
        relayRecoveryAllowed = true;
        relayAttempts = 0;
        emit('authenticated');
        updatePresence(message);
      } else if (message.type === 'presence' && authenticated) {
        updatePresence(message);
      } else if (authenticated && channel) {
        channel.handle(message);
      }
    } catch {
      emit('error', { message: '协议处理失败' });
    }
  };
  currentSocket.onclose = event => {
    if (connection !== epoch || socket !== currentSocket) return;
    socket = null;
    clearChannel();
    authenticated = false;
    onlineDevices.clear();
    devices = [];
    relayRetryPending = relayRecoveryAllowed && relayAttempts < MAX_RELAY_ATTEMPTS && TRANSIENT_RELAY_CLOSE_CODES.has(event.code);
    if (!relayRetryPending) relayRecoveryAllowed = false;
    emit('disconnected', {
      scope: 'relay', selectedDeviceId: route, code: event.code,
      retrying: relayRetryPending && foreground,
      message: relayRetryPending
        ? (foreground ? '服务器连接已断开，正在重新连接…' : '服务器连接已断开，返回应用后将重新连接')
        : '服务器连接已断开，请重新连接；未确认的消息不会自动重发',
    });
    emitInventory();
    scheduleRelayRetry();
  };
  currentSocket.onerror = () => {
    // A failed WebSocket also emits close. Let close drive recovery and preserve the close code.
  };
}

(globalThis as any).connect = (url: string, credential: string) => {
  let target: URL, pairing: ReturnType<typeof parseBrowserPairingCredential> | null = null;
  try {
    target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error();
    if (credential) pairing = parseBrowserPairingCredential(credential);
  } catch {
    emit('error', { message: '服务器地址或配对链接无效' }); return;
  }
  clearRelayRetryTimer();
  relayTarget = target;
  relayRecoveryAllowed = relayRetryPending = false;
  relayAttempts = 0;
  openRelay(target, pairing, false);
};

(globalThis as any).setForeground = (active: boolean) => {
  foreground = active === true;
  if (foreground) scheduleRelayRetry();
  else clearRelayRetryTimer();
};

(globalThis as any).selectDevice = (id: string) => {
  const selected = String(id || '').trim();
  if (!selected) return;
  route = selected;
  clearChannel();
  channelAttempts = 0;
  emitInventory();
  if (!isRelayReady()) emit('disconnected', {
    scope: 'relay', selectedDeviceId: route, retrying: foreground && (relayRetryPending || relayAttempts > 0 && socket !== null),
    message: socket !== null || relayRetryPending ? '正在等待服务器连接，稍后将恢复电脑连接' : '服务器尚未连接，请先重新连接服务器',
  });
  else if (canConnectDevice()) startChannel();
  else emit('disconnected', { scope: 'device', selectedDeviceId: route, message: '电脑尚未在线，请检查连接器' });
};

(globalThis as any).request = (requestId: string, action: string, payload: any) => {
  // Requests are sent once only. Recovery must never replay commands with an uncertain result.
  if (!canConnectDevice() || !channel?.sendFrame({ type: 'request', requestId, action, payload })) {
    emit('requestFailed', { requestId, message: '设备尚未连接，指令未发送' });
  }
};

(globalThis as any).cancelConnection = () => {
  ++epoch;
  clearChannel();
  clearRelayRetryTimer();
  relayTarget = null;
  relayRecoveryAllowed = relayRetryPending = false;
  relayAttempts = 0;
  authenticated = false;
  onlineDevices.clear();
  devices = [];
  const previous = socket;
  socket = null;
  previous?.close(1000, 'connection cancelled');
  emitInventory();
};
