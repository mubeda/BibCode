[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd([char[]]'\/')
$destinationPath = [IO.Path]::GetFullPath($Destination)
$rootName = [IO.Path]::GetFileName($sourcePath)

if (-not [IO.Directory]::Exists($sourcePath)) {
  throw "ZIP source directory does not exist: $sourcePath"
}
if ([IO.File]::Exists($destinationPath)) {
  throw "ZIP destination already exists: $destinationPath"
}
if ([string]::IsNullOrWhiteSpace($rootName)) {
  throw "ZIP source directory must have a root name."
}

$archive = [IO.Compression.ZipFile]::Open(
  $destinationPath,
  [IO.Compression.ZipArchiveMode]::Create
)
try {
  Get-ChildItem -LiteralPath $sourcePath -Recurse -File -Force |
    Sort-Object -Property FullName |
    ForEach-Object {
      $relativePath = $_.FullName.Substring($sourcePath.Length).TrimStart([char[]]'\/')
      $portablePath = $relativePath.Replace('\', '/')
      $entryName = "$rootName/$portablePath"
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $_.FullName,
        $entryName,
        [IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
}
finally {
  $archive.Dispose()
}
