# Back up the core SQLite database (consistent VACUUM INTO snapshot) and the
# TeslaMate Postgres database. Schedule weekly, e.g.:
#   schtasks /Create /SC WEEKLY /D SUN /TN "Hoymiles DB backup" /TR "powershell -ExecutionPolicy Bypass -File D:\work\hoymiles-dashboard\scripts\backup.ps1" /ST 03:00
param(
    [string]$OutDir = "D:\backups\hoymiles"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

# Core (SQLite): VACUUM INTO produces a consistent snapshot even mid-write.
docker exec hoymiles-dashboard-api-1 node -e "const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient(); p.\$executeRawUnsafe(\`VACUUM INTO '/data/backup-tmp.db'\`).then(() => p.\$disconnect())"
docker cp "hoymiles-dashboard-api-1:/data/backup-tmp.db" (Join-Path $OutDir "solar-$stamp.db")
docker exec hoymiles-dashboard-api-1 rm /data/backup-tmp.db

# TeslaMate (Postgres)
$containerPath = "/tmp/teslamate-$stamp.dump"
docker exec hoymiles-dashboard-db-1 pg_dump -U hoymiles -d teslamate -F c -f $containerPath
docker cp "hoymiles-dashboard-db-1:$containerPath" (Join-Path $OutDir "teslamate-$stamp.dump")
docker exec hoymiles-dashboard-db-1 rm $containerPath

# Keep the newest 12 of each.
foreach ($pattern in @("solar-*.db", "teslamate-*.dump", "hoymiles-*.dump")) {
    Get-ChildItem $OutDir -Filter $pattern |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 12 |
        Remove-Item
}

Write-Host "Backups written to $OutDir"
