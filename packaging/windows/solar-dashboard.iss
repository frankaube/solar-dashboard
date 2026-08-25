; Inno Setup script for the Solar Dashboard Windows installer.
;
; Build with:  node packaging/build-installer.mjs
; which runs `build.mjs win` first and passes AppVersion in via /D.
;
; NOTE: the installer is not code-signed, so Windows will show a SmartScreen
; warning on first download. Signing needs a certificate we do not have.

#ifndef AppVersion
  #define AppVersion "0.9.0"
#endif

; Compile-time guard. WinSW is a separate download (see build-installer.mjs);
; without it the [Run] service steps would fail silently at install time and the
; user would end up with a dashboard that never starts after a reboot.
#ifnexist "..\out\win\service\SolarDashboardService.exe"
  #error WinSW is missing. Put WinSW-x64.exe at packaging/out/win/service/SolarDashboardService.exe — see packaging/build-installer.mjs.
#endif

[Setup]
; A stable AppId is what makes the next version replace this one instead of
; installing beside it. Never change it.
AppId={{7A1B0E42-9C3D-4F58-B2E6-5D0C8A4F1E93}
AppName=Solar Dashboard
AppVersion={#AppVersion}
AppPublisher=Solar Dashboard
DefaultDirName={autopf}\SolarDashboard
DefaultGroupName=Solar Dashboard
OutputDir=..\out
OutputBaseFilename=SolarDashboardSetup
Compression=lzma2
SolidCompression=yes
; The service registers machine-wide and writes to ProgramData, so this needs admin.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\solar-dashboard.exe

[Files]
; Excludes keep a previous install's runtime state out of the package — data
; lives in ProgramData now, but an older layout may have left some in {app}.
Source: "..\out\win\*"; DestDir: "{app}"; Excludes: "service\*.log,data\*"; \
  Flags: recursesubdirs createallsubdirs ignoreversion

[Tasks]
; Off by default. The app is local-first; reaching it from your phone is a
; deliberate choice, not something an installer should assume.
Name: "firewall"; Description: "Let my phone and other devices open http://solar-dashboard.local:3001"; \
  GroupDescription: "Network access"; Flags: unchecked

[Icons]
Name: "{group}\Solar Dashboard"; Filename: "http://localhost:3001"
Name: "{group}\Uninstall Solar Dashboard"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\service\SolarDashboardService.exe"; Parameters: "install"; \
  StatusMsg: "Registering the background service…"; Flags: runhidden
Filename: "{app}\service\SolarDashboardService.exe"; Parameters: "start"; \
  StatusMsg: "Starting Solar Dashboard…"; Flags: runhidden
Filename: "netsh"; \
  Parameters: "advfirewall firewall add rule name=""Solar Dashboard"" dir=in action=allow protocol=TCP localport=3001"; \
  Tasks: firewall; Flags: runhidden
; Without this the name resolves nowhere off-machine: the dashboard would be
; reachable at the IP but solar-dashboard.local would not, which is the one thing
; this task exists to make work.
Filename: "netsh"; \
  Parameters: "advfirewall firewall add rule name=""Solar Dashboard mDNS"" dir=in action=allow protocol=UDP localport=5353"; \
  Tasks: firewall; Flags: runhidden
Filename: "http://localhost:3001"; Description: "Open Solar Dashboard"; \
  Flags: postinstall shellexec nowait

[UninstallRun]
Filename: "{app}\service\SolarDashboardService.exe"; Parameters: "stop"; \
  Flags: runhidden; RunOnceId: "StopSvc"
Filename: "{app}\service\SolarDashboardService.exe"; Parameters: "uninstall"; \
  Flags: runhidden; RunOnceId: "UninstSvc"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Solar Dashboard"""; \
  Flags: runhidden; RunOnceId: "DelFwRule"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Solar Dashboard mDNS"""; \
  Flags: runhidden; RunOnceId: "DelFwRuleMdns"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\service\*.log"

[Code]
{
  Upgrades: the service holds solar-dashboard.exe open, so replacing files fails
  with "in use" unless it is stopped and deregistered first. Runs before any
  file is touched.
}
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Wrapper: String;
  ResultCode: Integer;
begin
  Result := '';
  Wrapper := ExpandConstant('{app}\service\SolarDashboardService.exe');
  if FileExists(Wrapper) then
  begin
    Exec(Wrapper, 'stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(Wrapper, 'uninstall', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    { WinSW deregisters asynchronously; give the SCM a moment to release the exe. }
    Sleep(3000);
  end;
end;

{
  Recorded history is kept by default — someone uninstalling to reinstall a newer
  build should not silently lose two years of readings. Asked, not assumed.
}
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{commonappdata}\SolarDashboard');
    if DirExists(DataDir) then
    begin
      if MsgBox('Also delete your recorded energy history?'#13#10#13#10
                + DataDir + #13#10#13#10
                + 'Choose No to keep it — a future install will pick it back up.',
                mbConfirmation, MB_YESNO) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
