param([Parameter(Mandatory)][string]$LogFile)
# Passive software-reboot gate. Never transmits bytes or changes the device.
Add-Type -AssemblyName System.IO.Ports
$p=[IO.Ports.SerialPort]::new('COM4',115200,[IO.Ports.Parity]::None,8,[IO.Ports.StopBits]::One)
$p.Handshake=[IO.Ports.Handshake]::None;$p.DtrEnable=$false;$p.RtsEnable=$false
$p.Encoding=[Text.Encoding]::GetEncoding(28591)
$log=[Text.StringBuilder]::new()
$map='blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)'
$passed=$false
try {
    $p.Open();Write-Output 'PASSIVE_SERIAL_READY_FOR_PURE_MAP_PROBE'
    $t=[Diagnostics.Stopwatch]::StartNew()
    while($t.Elapsed.TotalSeconds -lt 180){
        $s=$p.ReadExisting()
        if($s){
            [void]$log.Append($s);[Console]::Write($s);[Console]::Out.Flush()
            $all=$log.ToString()
            [IO.File]::WriteAllText($LogFile,$all,[Text.UTF8Encoding]::new($false))
            if($all -match 'Bootrom start' -and $all.Contains($map) -and $all -match '(?m)^bootcmd=printenv\r?$' -and $all -match '(?m)^bootdelay=3\r?$' -and $all -match '(?m)^fastboot#\s*$'){
                $passed=$true;Write-Output "`nFRESH_BOOTLOADER_PURE_MAP_PRINTENV_PROMPT_OBSERVED_SOFTWARE_REBOOT_ONLY";break
            }
            if($all -match 'Uncompressing Linux|Starting kernel|Kernel panic'){throw 'Probe unexpectedly attempted a kernel boot'}
        }
        Start-Sleep -Milliseconds 5
    }
    if(-not $passed){throw 'New-map software-reboot gate not observed; inspect captured log before any operation'}
} finally {
    if($p.IsOpen){$p.Close()};$p.Dispose()
    [IO.File]::WriteAllText($LogFile,$log.ToString(),[Text.UTF8Encoding]::new($false))
}
