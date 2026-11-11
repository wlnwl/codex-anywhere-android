$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
$env:JAVA_HOME='C:\Program Files\Java\jdk-21'
$sdk="$env:LOCALAPPDATA\Android\Sdk"
$bt="$sdk\build-tools\35.0.0"
$jar="$sdk\platforms\android-35\android.jar"
New-Item -ItemType Directory -Force res,out/classes,out/dex | Out-Null
& "$bt\aapt.exe" package -f -M AndroidManifest.xml -S res -A assets -I $jar -F out/base.apk
javac -encoding UTF-8 -source 8 -target 8 -classpath "$jar;libs/zxing-core-3.5.3.jar" -d out/classes src/local/codex/anywhere/*.java
$classes=(Get-ChildItem out/classes -Recurse -Filter *.class).FullName
& "$bt\d8.bat" --lib $jar --output out/dex $classes libs/zxing-core-3.5.3.jar
Copy-Item out/base.apk out/unsigned.apk -Force
Push-Location out/dex
& "$bt\aapt.exe" add ../unsigned.apk classes.dex
Pop-Location
& "$bt\zipalign.exe" -f 4 out/unsigned.apk out/aligned.apk
$keytool=Join-Path $env:JAVA_HOME bin/keytool.exe
if(!(Test-Path out/development.jks)){& $keytool -genkeypair -keystore out/development.jks -storepass android -keypass android -alias development -dname 'CN=Codex Anywhere Local' -keyalg RSA -validity 3650}
& "$bt\apksigner.bat" sign --ks out/development.jks --ks-pass pass:android --out out/CodexAnywhere-0.6.2.apk out/aligned.apk
& "$bt\apksigner.bat" verify out/CodexAnywhere-0.6.2.apk
