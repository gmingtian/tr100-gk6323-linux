param([Parameter(Mandatory)][string]$LogFile,[int]$DurationSeconds=300)
# Passive capture of pure-Linux default autoboot. Never transmits serial bytes.
Add-Type -AssemblyName System.IO.Ports
$p=[IO.Ports.SerialPort]::new('COM4',115200,[IO.Ports.Parity]::None,8,[IO.Ports.StopBits]::One)
$p.Handshake=[IO.Ports.Handshake]::None;$p.DtrEnable=$false;$p.RtsEnable=$false
$p.Encoding=[Text.Encoding]::GetEncoding(28591)
$log=[Text.StringBuilder]::new()
try {
    $p.Open();Write-Output 'PASSIVE_SERIAL_READY_FOR_DEFAULT_EMMC_BOOT'
    $t=[Diagnostics.Stopwatch]::StartNew()
    while($t.Elapsed.TotalSeconds -lt $DurationSeconds){
        $s=$p.ReadExisting()
        if($s){
            [void]$log.Append($s);[Console]::Write($s);[Console]::Out.Flush()
            $all=$log.ToString()
            if($all -match '\[tr100-initrd\] STOPPED:|\[tr100-rom\] BOOTSTRAP FAILED:|Kernel panic'){
                Write-Output "`nPERSISTENT_BOOT_REQUIRES_DIAGNOSIS";break
            }
            if($all -match 'Validated persistent root /dev/mmcblk0p8' -and $all -match 'lease of ([0-9.]+) obtained' -and $all -match '(?m)^tr100 login:\s*$'){
                Write-Output "`nPURE_P8_ROOT_DHCP_AND_NORMAL_SERIAL_LOGIN_OBSERVED";break
            }
            [IO.File]::WriteAllText($LogFile,$all,[Text.UTF8Encoding]::new($false))
        }
        Start-Sleep -Milliseconds 5
    }
} finally {
    if($p.IsOpen){$p.Close()};$p.Dispose()
    [IO.File]::WriteAllText($LogFile,$log.ToString(),[Text.UTF8Encoding]::new($false))
}
