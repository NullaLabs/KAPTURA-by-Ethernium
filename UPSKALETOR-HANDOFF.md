# KAPTURA → UPSKALETOR

KAPTURA and UPSKALETOR are independent products. KAPTURA captures and saves the
master; UPSKALETOR processes a new output file. The browser never launches
PowerShell, uploads the video, or pretends to upscale it.

## Guided handoff

1. Record and save the master in KAPTURA.
2. Open the **UPSKALETOR** tab.
3. Select the saved master and choose a real UPSKALETOR profile and encoder.
4. Copy the safe dry-run command or download the JSON handoff manifest.
5. If you are an authorized NullaLabs operator, install the signed private
   UPSKALETOR release. Public KAPTURA users should use the built-in Lanczos
   profiles or another independently verified processor; access to the private
   companion is not bundled or implied.
6. Place the master in the terminal's working folder and run the dry run.
7. Run the processing command only after the dry run reports the expected plan.

The generated commands target the default per-user installation:

```powershell
& "$env:LOCALAPPDATA\Ethernium\UPSKALETOR\upskaletor.ps1" `
  -InputFile '.\KAPTURA_MASTER.webm' `
  -Mode AI -Width 3840 -Height 2160 -TargetFps 0 -Encoder Auto `
  -DryRun -Json
```

`-TargetFps 0` preserves the detected source frame rate. UPSKALETOR writes a
separate MP4 and refuses to overwrite the input.
