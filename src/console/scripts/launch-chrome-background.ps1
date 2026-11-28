param([string]$ExecutablePath, [string]$ArgumentListJson)

Add-Type -Name N -Namespace T -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, System.IntPtr p);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(System.IntPtr h);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr p);
'@

$SW_MINIMIZE = 6
$arguments = $ArgumentListJson | ConvertFrom-Json
$restoreTo = [T.N]::GetForegroundWindow()

# 本次启动之前，所有 chrome 进程的 id 快照。之后只处理新出现的那些。
$before = @(Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })

$proc = Start-Process -FilePath $ExecutablePath -ArgumentList $arguments -WindowStyle Minimized -PassThru

$targets = @()
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $script:newChromeIds = @{}
  Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } |
    ForEach-Object { $script:newChromeIds[$_.Id] = $true }
  if ($script:newChromeIds.Count -eq 0) { Start-Sleep -Milliseconds 150; continue }

  $script:found = @()
  $cb = [T.N+EnumProc]{
    param($h, $p)
    $ownerPid = 0
    [void][T.N]::GetWindowThreadProcessId($h, [ref]$ownerPid)
    if ($script:newChromeIds.ContainsKey([int]$ownerPid) -and [T.N]::IsWindowVisible($h) -and [T.N]::GetWindowTextLength($h) -gt 0) {
      $script:found += $h
    }
    return $true
  }
  [void][T.N]::EnumWindows($cb, [System.IntPtr]::Zero)
  if ($script:found.Count -gt 0) { $targets = $script:found; break }
  Start-Sleep -Milliseconds 150
}

foreach ($h in $targets) {
  [void][T.N]::ShowWindow($h, $SW_MINIMIZE)
}
Write-Output ("minimized=" + $targets.Count)
Write-Output ("new-chrome-procs=" + $script:newChromeIds.Count)

if ($restoreTo -ne [System.IntPtr]::Zero) {
  [void][T.N]::SetForegroundWindow($restoreTo)
  Write-Output "restored-foreground"
}
