param([Parameter(Mandatory)][string]$LogFile)
# One RAM boot attempt of the image independently loaded/CRC checked by the caller.
Add-Type -AssemblyName System.IO.Ports
$p=[IO.Ports.SerialPort]::new('COM4',115200,[IO.Ports.Parity]::None,8,[IO.Ports.StopBits]::One)
$p.Handshake=[IO.Ports.Handshake]::None;$p.DtrEnable=$false;$p.RtsEnable=$false
$p.Encoding=[Text.Encoding]::GetEncoding(28591);$p.WriteTimeout=1000
$log=[Text.StringBuilder]::new()
function Read-Serial {
    $s=$p.ReadExisting();if($s){[void]$log.Append($s);[Console]::Write($s);[Console]::Out.Flush()}
}
function Send-Paced([string]$s){foreach($c in ($s+"`r").ToCharArray()){$p.Write([string]$c);Start-Sleep -Milliseconds 10;Read-Serial}}
function Set-Volatile([string]$s){
    $start=$log.Length;Send-Paced $s;$t=[Diagnostics.Stopwatch]::StartNew()
    while($t.Elapsed.TotalSeconds -lt 5){Read-Serial;if($log.ToString($start,$log.Length-$start) -match '(?m)^fastboot#\s*$'){return};Start-Sleep -Milliseconds 5}
    throw 'Bootloader did not return prompt; boot not sent'
}
try {
    $p.Open();Start-Sleep -Milliseconds 100;Read-Serial
    $p.Write([byte[]]@(3),0,1);Start-Sleep -Milliseconds 100;Read-Serial
    Set-Volatile ''
    $bootArguments='console=ttyAMA0,115200 blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs) loglevel=7 rdinit=/init init=/init ignore_loglevel panic=10 systemd.unified_cgroup_hierarchy=0 systemd.legacy_systemd_cgroup_controller=1 systemd.gpt_auto=0 rd.systemd.gpt_auto=0 net.ifnames=0'
    Set-Volatile ("setenv bootargs '"+$bootArguments+"'")
    Set-Volatile 'setenv autostart yes'
    $start=$log.Length
    Send-Paced 'bootm 0x40000000'
    $t=[Diagnostics.Stopwatch]::StartNew();$interrupt=$false;$lastInterrupt=-100
    while($t.Elapsed.TotalSeconds -lt 150){
        Read-Serial
        $segment=$log.ToString($start,$log.Length-$start)
        # If the test panics/restarts, prevent fallback Android from booting.
        if($segment -match 'Bootrom start'){$interrupt=$true}
        if($interrupt -and $t.ElapsedMilliseconds-$lastInterrupt -ge 20){$p.Write([byte[]]@(3),0,1);$lastInterrupt=$t.ElapsedMilliseconds}
        if($interrupt -and $segment -match '(?m)^fastboot#\s*$'){Write-Output "`nTEST_RESTARTED_FASTBOOT_INTERCEPTED";break}
        if($segment -match 'Emergency root shell on serial' -and $segment -match '(?m)[#] ?$'){Write-Output "`nBOOTSTRAP_RESCUE_SHELL_REQUIRES_DIAGNOSIS";break}
        if([regex]::Replace($segment,'\x1b\[[0-9;?]*[a-zA-Z]','') -match '(?m)^root@[^\r\n]+[#] ?$'){Write-Output "`nFULL_ROOT_SERIAL_SHELL_OBSERVED_REQUIRES_VERIFICATION";break}
        Start-Sleep -Milliseconds 5
    }
} finally {
    if($p.IsOpen){$p.Close()};$p.Dispose()
    [IO.File]::WriteAllText($LogFile,$log.ToString(),[Text.UTF8Encoding]::new($false))
}
