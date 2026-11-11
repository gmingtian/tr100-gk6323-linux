param([Parameter(Mandatory)][string]$Manifest,[Parameter(Mandatory)][string]$LogFile)
# Only volatile network settings, eMMC READ of original ATF, TFTP and CRC.
# Does not boot, save environment or write/erase any storage.
$m=Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
if(-not $m.RAMONLY -or $m.emmcFlashable -or $m.boot.address -ne 1073741824){throw 'Not the expected RAMONLY manifest'}
$next=1073741824L
foreach($f in $m.fragments){
    if($f.file -notmatch '^RAMONLY-part-[0-9]{3}\.bin$' -or $f.address -ne $next -or $f.bytes -le 0 -or $f.bytes -gt 16777216){throw 'Invalid RAM fragment'}
    $file=Join-Path (Split-Path -Parent $Manifest) $f.file
    if((Get-Item -LiteralPath $file).Length -ne $f.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $f.sha256){throw 'Fragment local hash/length mismatch'}
    $next+=$f.bytes
}
if($next-1073741824 -ne $m.boot.bytes -or $next -ge 0x70000000){throw 'Invalid aggregate RAM range'}
Add-Type -AssemblyName System.IO.Ports
$p=[IO.Ports.SerialPort]::new('COM4',115200,[IO.Ports.Parity]::None,8,[IO.Ports.StopBits]::One)
$p.Handshake=[IO.Ports.Handshake]::None;$p.DtrEnable=$false;$p.RtsEnable=$false
$p.Encoding=[Text.Encoding]::GetEncoding(28591);$p.WriteTimeout=1000
$log=[Text.StringBuilder]::new()
function Read-Serial {
    $s=$p.ReadExisting();if($s){[void]$log.Append($s);[Console]::Write($s);[Console]::Out.Flush()}
}
function Run-Fastboot([string]$command,[int]$timeout=120){
    $start=$log.Length
    foreach($c in ($command+"`r").ToCharArray()){$p.Write([string]$c);Start-Sleep -Milliseconds 10;Read-Serial}
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while($timer.Elapsed.TotalSeconds -lt $timeout){
        Read-Serial
        $segment=$log.ToString($start,$log.Length-$start)
        if($segment -match '(?m)^fastboot#\s*$'){
            [IO.File]::WriteAllText($LogFile,$log.ToString(),[Text.UTF8Encoding]::new($false))
            if($segment -match 'TFTP error|Retry count exceeded|Unknown command|## Error|Usage:'){throw "Fastboot command failed: $command"}
            return $segment
        }
        Start-Sleep -Milliseconds 5
    }
    throw "Fastboot command timeout: $command"
}
function Check-CRC([long]$address,[long]$bytes,[string]$expected){
    $reply=Run-Fastboot ('crc32 0x{0:x} 0x{1:x}' -f $address,$bytes)
    $found=[regex]::Match($reply,'==>\s*([0-9a-fA-F]{8})')
    if(-not $found.Success -or $found.Groups[1].Value.ToLowerInvariant() -ne $expected){throw "RAM CRC mismatch at $address"}
}
try {
    $p.Open();Start-Sleep -Milliseconds 100;Read-Serial
    # Refresh the already-confirmed idle fastboot console after USB-UART reopen.
    $p.Write([byte[]]@(3),0,1);Start-Sleep -Milliseconds 100;Read-Serial
    $null=Run-Fastboot '' 5
    foreach($command in @('setenv ipaddr 192.168.5.240','setenv serverip 192.168.5.253','setenv netmask 255.255.255.0','setenv autoload no','setenv autostart no','setenv tftpblocksize 1468')){$null=Run-Fastboot $command 5}
    $null=Run-Fastboot 'mmc read 0 0x8020000 0xC000 0x1000'
    Check-CRC 0x8020000 0x200000 '96266b1b'
    foreach($f in $m.fragments){
        $reply=Run-Fastboot ('tftp 0x{0:x} {1}' -f [long]$f.address,$f.file)
        if($reply -notmatch ('Bytes transferred = '+$f.bytes+'\s')){throw 'TFTP transferred length mismatch'}
        Check-CRC $f.address $f.bytes $f.crc32
    }
    Check-CRC $m.boot.address $m.boot.bytes $m.boot.crc32
    Write-Output "`nFULL_RAMONLY_IMAGE_LOADED_ALL_CRCS_MATCHED_NOT_BOOTED"
} finally {
    if($p.IsOpen){$p.Close()};$p.Dispose()
    [IO.File]::WriteAllText($LogFile,$log.ToString(),[Text.UTF8Encoding]::new($false))
}
