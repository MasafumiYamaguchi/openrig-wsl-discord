param([ValidateSet('start','doctor','register','invite')][string]$Mode = 'start', [string]$Distro = 'Ubuntu-24.04')
$ErrorActionPreference = 'Stop'
$convertedPath = wsl.exe -d $Distro --exec wslpath -u "$PSScriptRoot/discord-bot.sh"
if ($LASTEXITCODE -ne 0 -or !$convertedPath) { throw 'WSL path conversion failed.' }
$linuxScript = $convertedPath.Trim()
if ($Mode -eq 'start') {
    $arguments = @('-w','new','new-tab','--title','OpenRig-Discord','wsl.exe','-d',$Distro,'--exec','bash',('"' + $linuxScript + '"'),'start')
    Start-Process -FilePath "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe" -ArgumentList $arguments
} else {
    & wsl.exe -d $Distro --exec bash $linuxScript $Mode
    exit $LASTEXITCODE
}
