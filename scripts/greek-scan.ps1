# Greek codepage scanner for Aclas PP7X (and similar ESC/POS printers)
# Runs on the venue Windows PC, sends raw bytes to the printer over TCP 9100.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File greek-scan.ps1
#   (or pass a different IP)   powershell -ExecutionPolicy Bypass -File greek-scan.ps1 -Ip 192.168.88.5
#
# Read the printed receipt: find the line where the Greek sample (ΑΒΓΔΕ αβγδε)
# prints CORRECTLY. The number on that line is the value to use.
#   - "t=NN" lines  -> use that NN as the `codePage` (ESC t n) value
#   - the section header tells you which `characterSet` (encoding) matches

param(
  [string]$Ip = "192.168.88.5",
  [int]$Port = 9100,
  [int]$MaxN = 63
)

$ESC = 0x1B
$GS  = 0x1D
$LF  = 0x0A

# Greek sample: uppercase + lowercase + final sigma + a couple of accents + euro
$sample = [char]0x0391 + [char]0x0392 + [char]0x0393 + [char]0x0394 + [char]0x0395 + " " +
          [char]0x03B1 + [char]0x03B2 + [char]0x03B3 + [char]0x03B4 + [char]0x03B5 + [char]0x03C2 + " " +
          [char]0x03AC + [char]0x03AD + " " + [char]0x20AC  # ά έ €

# Encodings to test. CodePage 28597 = ISO-8859-7. 1253 = Windows-1253. 869 / 737 = DOS Greek.
$encodings = @(737, 869, 1253, 28597)

Write-Host "Connecting to $Ip`:$Port ..."
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect($Ip, $Port)
$stream = $client.GetStream()

function Send([byte[]]$bytes) { $stream.Write($bytes, 0, $bytes.Length) }
function SendAscii([string]$s) { Send([System.Text.Encoding]::ASCII.GetBytes($s)) }
function Init() { Send([byte[]]@($ESC, 0x40)) }              # ESC @  -> reset to printer default
function SetPage([int]$n) { Send([byte[]]@($ESC, 0x74, $n)) } # ESC t n -> select code page n
function NL() { Send([byte[]]@($LF)) }

Init
SendAscii "=== GREEK CODEPAGE SCAN ==="; NL
SendAscii "find the line with correct Greek"; NL; NL

# --- Section 1: default page (no ESC t), one line per encoding ---
SendAscii "-- DEFAULT PAGE (no ESC t) --"; NL
foreach ($cp in $encodings) {
  Init                                  # back to default page each time
  SendAscii ("def enc=" + $cp + ": ")
  $enc = [System.Text.Encoding]::GetEncoding($cp)
  Send($enc.GetBytes($sample))
  NL
}
NL

# --- Section 2: scan ESC t n for each candidate encoding ---
foreach ($cp in $encodings) {
  $enc = [System.Text.Encoding]::GetEncoding($cp)
  SendAscii ("-- ESC t n, enc=" + $cp + " --"); NL
  for ($n = 0; $n -le $MaxN; $n++) {
    SetPage $n
    SendAscii ("t=" + $n + " : ")
    Send($enc.GetBytes($sample))
    NL
  }
  NL
}

# feed + cut
Send([byte[]]@($LF, $LF, $LF, $LF))
Init
Send([byte[]]@($GS, 0x56, 0x00))   # GS V 0 -> full cut

$stream.Flush()
Start-Sleep -Milliseconds 300
$client.Close()
Write-Host "Done. Read the receipt and report the matching line."
