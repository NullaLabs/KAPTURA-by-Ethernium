# 📹 KAPTURA by Ethernium

> **CHRONO Capture Engine · local-first browser studio**

KAPTURA conserva CHRONO como motor de captura y añade una frontera de producto
explícita con UPSKALETOR. Graba una pantalla, pestaña o escena generativa con
MediaRecorder, descarga el master real producido por el navegador y conserva
un historial local en IndexedDB.

[Abrir KAPTURA](https://steveblackbeard.github.io/KAPTURA-by-Ethernium/) ·
[Descargar releases](https://github.com/SteveBlackbeard/KAPTURA-by-Ethernium/releases)

## Capacidades

- objetivos configurables hasta 4K y 120 FPS, limitados por navegador, sistema,
  fuente y hardware;
- selección de VP9, AV1 o MP4 cuando MediaRecorder realmente admite el formato;
- captura de audio de pestaña/sistema cuando la fuente y el navegador la ofrecen;
- descarga del master sin cambiar de contenedor mediante una extensión ficticia;
- Vault local en IndexedDB;
- V-CONVERTER con manifiesto y comando para el helper MP4 incluido;
- pestaña UPSKALETOR con perfiles y parámetros compatibles con su release v0.6.0.

KAPTURA es 100% autónoma y opera en régimen Airgap estricto: no sube el vídeo a ningún servidor ni realiza peticiones externas. La interfaz utiliza fuentes locales de silicio y sella cada grabación con recibos Merkle notariales.



## Inicio rápido

### Aplicación web

Abre la [versión publicada](https://steveblackbeard.github.io/KAPTURA-by-Ethernium/)
en Chrome, Edge o Brave.

### Paquete portátil para Windows

1. Descarga `KAPTURA-by-Ethernium-v1.0.0.zip` y su `.sha256` desde Releases.
2. Verifica el ZIP:

   ```powershell
   (Get-FileHash .\KAPTURA-by-Ethernium-v1.0.0.zip -Algorithm SHA256).Hash
   ```

3. Extrae el ZIP en una carpeta nueva.
4. Ejecuta `KAPTURA.cmd`. No requiere instalación ni privilegios de administrador.

También puedes abrir `index.html` directamente.

## Captura

1. Selecciona **RECORDER STUDIO**.
2. Para una pantalla o pestaña, pulsa **SELECT SOURCE** y confirma la fuente.
3. Elige resolución, FPS, bitrate y códec objetivo.
4. Pulsa **START RECORDING**.
5. Pulsa **STOP & SAVE MASTER**. El nombre y la extensión corresponden al MIME
   que MediaRecorder utilizó realmente.
6. Conserva ese master; cualquier conversión se realiza como archivo nuevo.

## V-CONVERTER

El navegador solo prepara el traspaso. Para el helper MP4 incluido:

```powershell
python -m pip install -r requirements.txt
python .\convert_webm_to_mp4.py ".\captura.webm"
```

El helper usa FFmpeg proporcionado por `imageio-ffmpeg` y produce un MP4 nuevo.
No sobrescribe el archivo fuente.

## KAPTURA → UPSKALETOR

- **KAPTURA / CHRONO** captura y conserva el master.
- **[UPSKALETOR-by-Ethernium](https://github.com/SteveBlackbeard/UPSKALETOR-by-Ethernium)**
  procesa el master mediante IA o Lanczos en su propio repositorio, instalador,
  CI y releases firmadas.

En la pestaña **UPSKALETOR**:

1. selecciona el master;
2. elige un perfil y encoder reales;
3. copia primero el dry run seguro;
4. descarga opcionalmente el manifiesto JSON;
5. ejecuta el comando desde tu instalación local de UPSKALETOR.

Consulta [UPSKALETOR-HANDOFF.md](UPSKALETOR-HANDOFF.md) para el procedimiento
completo. KAPTURA no incorpora, duplica ni simula el motor UPSKALETOR.

## Desarrollo y validación

```powershell
python .\tests\validate_kaptura.py
python -m compileall -q .
python .\scripts\build_release.py --output .\dist
```

El workflow de release solo publica cuando el tag coincide exactamente con
`v` + el contenido de `VERSION`.

Copyright © 2026 Steve Blackbeard. All rights reserved.
