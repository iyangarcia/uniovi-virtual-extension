; Uniovi Virtual: per-user Windows installer (no admin). Built by `npm run package` (scripts/package.mjs),
; which passes AppVersion, AppSrc (release\app), ExtSrc (extension\dist), NodeExe and OutputDir.
;
; Installs to %LOCALAPPDATA%\UnioviVirtual (fixed: server/src/config.ts looks for config.json, helper.pid
; and logs there):
;   node.exe, helper.js, package.json   portable Node + bundled helper (`node helper.js --service`)
;   host.cjs, host.cmd                  native-messaging host es.uniovi.virtual
;   es.uniovi.virtual.json              host manifest, rewritten at install with the absolute host.cmd path
;   extension\                          the unpacked extension (chrome://extensions → Cargar descomprimida)
; HKCU only: Chrome + Edge NativeMessagingHosts\es.uniovi.virtual, and a Run value that starts the helper
; at logon through `conhost.exe --headless`, so the console app node.exe gets no window (no VBScript).
; config.json is never shipped, so an existing one is kept. The data folder (Documents\Uniovi,
; ~/uniovi-data or a custom one) lives elsewhere and is never touched, not even on uninstall.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppSrc
  #define AppSrc "..\release\app"
#endif
#ifndef ExtSrc
  #define ExtSrc "..\extension\dist"
#endif
#ifndef NodeExe
  #define NodeExe "..\release\cache\node.exe"
#endif
#ifndef OutputDir
  #define OutputDir "..\release"
#endif

#define HostName "es.uniovi.virtual"
; Quotes are doubled inside quoted Inno values; single-quoted ISPP strings keep them as written.
#define HelperArgs '--headless ""{app}\node.exe"" ""{app}\helper.js"" --service'
#define HelperCmd '""{sys}\conhost.exe"" ' + HelperArgs

[Setup]
AppId={{05275746-9850-4397-BBA1-E973638AB591}
AppName=Uniovi Virtual
AppVersion={#AppVersion}
AppVerName=Uniovi Virtual {#AppVersion}
AppComments=Extensión no oficial para Uniovi Virtual y asistente local para usarla con IAs web
DefaultDirName={localappdata}\UnioviVirtual
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=UnioviVirtual-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
; The helper is stopped by PrepareToInstall / [UninstallRun] instead.
CloseApplications=no
UninstallDisplayName=Uniovi Virtual
InfoAfterFile=LEEME.txt

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[InstallDelete]
; Drop files of an older extension build (Chrome reloads the folder anyway).
Type: filesandordirs; Name: "{app}\extension"

[Files]
Source: "{#NodeExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppSrc}\helper.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppSrc}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppSrc}\host.cjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppSrc}\host.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppSrc}\{#HostName}.json"; DestDir: "{app}"; Flags: ignoreversion; AfterInstall: WriteHostManifest
Source: "{#ExtSrc}\*"; Excludes: "*.map"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "LEEME.txt"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#HostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#HostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "UnioviVirtual"; ValueData: "{#HelperCmd}"; Flags: uninsdeletevalue

[Run]
; Interactive install: optional, checked by default. Silent install: only with /STARTHELPER.
Filename: "{sys}\conhost.exe"; Parameters: "--headless ""{app}\node.exe"" ""{app}\helper.js"" --service"; WorkingDir: "{app}"; Description: "Iniciar el asistente ahora"; Flags: postinstall nowait runhidden skipifsilent
Filename: "{sys}\conhost.exe"; Parameters: "--headless ""{app}\node.exe"" ""{app}\helper.js"" --service"; WorkingDir: "{app}"; Flags: nowait runhidden; Check: SilentStartRequested
Filename: "{app}\extension"; Description: "Abrir la carpeta de la extensión (para cargarla en Chrome)"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
; Stop the helper (and its tunnel client) before its files are removed: same logic as the popup's Detener.
Filename: "{sys}\conhost.exe"; Parameters: "--headless ""{app}\node.exe"" ""{app}\host.cjs"" --stop"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "StopHelper"

[UninstallDelete]
; Everything the helper writes in the app folder. Listed one by one (not the whole {app}) on purpose.
Type: files; Name: "{app}\helper.pid"
Type: files; Name: "{app}\config.json"
Type: files; Name: "{app}\config.json.tmp"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\tunnel"
Type: dirifempty; Name: "{app}"

[Code]
function SilentStartRequested: Boolean;
begin
  Result := WizardSilent and (Pos('/STARTHELPER', Uppercase(GetCmdTail)) > 0);
end;

{ Upgrade: stop a running helper first, so node.exe and helper.js can be replaced. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  App: String;
  Code: Integer;
begin
  Result := '';
  App := ExpandConstant('{app}');
  if CompareText(App, ExpandConstant('{localappdata}\UnioviVirtual')) <> 0 then
  begin
    Result := 'Uniovi Virtual tiene que instalarse en ' + ExpandConstant('{localappdata}\UnioviVirtual') + '.';
    exit;
  end;
  if FileExists(App + '\node.exe') and FileExists(App + '\host.cjs') then
  begin
    if not Exec(ExpandConstant('{sys}\conhost.exe'), '--headless "' + App + '\node.exe" "' + App + '\host.cjs" --stop', App, SW_HIDE, ewWaitUntilTerminated, Code) then
      Log('Could not run host.cjs --stop')
    else
      Log(Format('host.cjs --stop exited with %d', [Code]));
  end;
end;

{ The shipped manifest has "path": "host.cmd" (relative, valid on Windows); write the absolute path,
  UTF-8 without BOM, so a user folder with non-ASCII characters stays valid JSON for Chrome. }
procedure WriteHostManifest;
var
  Lines: TArrayOfString;
  Manifest, HostCmd: String;
  I, Changed: Integer;
begin
  Manifest := ExpandConstant('{app}\{#HostName}.json');
  HostCmd := ExpandConstant('{app}\host.cmd');
  StringChangeEx(HostCmd, '\', '\\', True);
  if not LoadStringsFromFile(Manifest, Lines) then
    RaiseException('No se pudo leer ' + Manifest);
  Changed := 0;
  for I := 0 to GetArrayLength(Lines) - 1 do
    Changed := Changed + StringChangeEx(Lines[I], '"path": "host.cmd"', '"path": "' + HostCmd + '"', True);
  if Changed <> 1 then
    RaiseException('Manifiesto del host inesperado: ' + Manifest);
  if not SaveStringsToUTF8FileWithoutBOM(Manifest, Lines, False) then
    RaiseException('No se pudo escribir ' + Manifest);
end;
