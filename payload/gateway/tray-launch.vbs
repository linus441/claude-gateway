' Launch the Claude gateway tray app with no visible window.
' PowerShell itself starts hidden (window style 0) and then starts node
' with CREATE_NO_WINDOW, so no console window ever appears.
' Path is resolved from this script's own folder, so the package can sit anywhere.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\tray.ps1"""
sh.Run cmd, 0, False
