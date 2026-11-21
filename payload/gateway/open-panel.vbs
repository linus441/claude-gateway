' Claude gateway control panel launcher
' Double-click: opens the panel in an Edge app window (no address bar, no console)
' Path is resolved from this script's own folder, so the package can sit anywhere.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\open-panel.ps1""", 0, False
