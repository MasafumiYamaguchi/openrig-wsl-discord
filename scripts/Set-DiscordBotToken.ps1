param([string]$Distro = 'Ubuntu-24.04')
$ErrorActionPreference = 'Stop'
$convertedPath = wsl.exe -d $Distro --exec wslpath -u "$PSScriptRoot/discord-setup-token.sh"
if ($LASTEXITCODE -ne 0 -or !$convertedPath) { throw 'WSL path conversion failed.' }
$linuxScript = $convertedPath.Trim()
$arguments = @('-w','new','new-tab','--title','Discord-Bot-Token','wsl.exe','-d',$Distro,'--exec','bash',('"' + $linuxScript + '"'))
Start-Process -FilePath "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe" -ArgumentList $arguments
