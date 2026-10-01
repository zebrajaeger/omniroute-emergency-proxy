# OmniRoute Responses Compatibility Proxy

Kleiner lokal betreibbarer Reverse Proxy für **Node.js >= 20**, ohne externe
Dependencies. Die Kette lautet:

```text
OpenChamber → OpenCode → Proxy → OmniRoute → Provider
```

Alle HTTP-Routen werden grundsätzlich transparent weitergeleitet. Ausschließlich
bei `POST /v1/responses` mit einer Upstream-Antwort vom Typ `text/event-stream`
wird der bekannte synthetische Initial-Frame entfernt:

```text
data: {"type":"response.in_progress","sequence_number":1,"response":{"id":null,"status":"in_progress"}}

```

Dieser Frame hat kein `event:`-Feld, erscheint vor `response.created` und kann in
OpenCode `Invalid omniroute/openai-responses stream event` verursachen.

## Installation und Start

Im Projektverzeichnis:

```sh
npm install
npm test
npm start
```

Standardwerte:

- Proxy: `http://127.0.0.1:20129`
- OmniRoute: `http://192.168.178.2:20128`

`npm run dev` startet optional mit Node.js Watch-Modus. Zum Beenden `Ctrl+C`.

## Konfiguration

### Lokale Konfigurationsdatei

In `config.json` im Projektverzeichnis lassen sich Upstream-URL und API-Key
hinterlegen. Die lokale Datei wurde mit der Standard-URL und leerem Key angelegt.
Bei einem frischen Checkout zunächst die mitgelieferte Vorlage kopieren:

```powershell
Copy-Item config.example.json config.json
```

Inhalt von `config.json` (den Beispiel-Key durch den echten Key ersetzen):

```json
{
  "upstreamBaseUrl": "http://192.168.178.2:20128",
  "apiKey": "DEIN-OMNIROUTE-API-KEY"
}
```

`apiKey` enthält nur den Key, **ohne** den Präfix `Bearer `. Ein leerer Key (`""`)
deaktiviert den Fallback. Bei Requests ohne `Authorization` **und** ohne
`x-api-key` ergänzt der Proxy `Authorization: Bearer <apiKey>` für OmniRoute.
Vorhandene Auth-Header werden niemals überschrieben, auch nicht leere Header.
Das betrifft alle weitergeleiteten HTTP-Routen.

Die Datei wird beim Start geladen; nach Änderungen den Proxy neu starten.
Sie wird unabhängig vom aktuellen Arbeitsverzeichnis aus dem Projektverzeichnis
geladen. Ohne Datei gelten weiterhin die Standardwerte. Ungültiges JSON oder
ungültige Feldwerte verhindern den Start, ohne den Key zu loggen.

**Secrets:** `config.json` ist in `.gitignore` ausgeschlossen und darf nicht
eingecheckt oder geteilt werden. `config.example.json` bleibt ohne Secrets.
Der Key wird im Klartext gespeichert; die Datei nur dem eigenen Benutzer
zugänglich halten. Der Proxy bleibt ohne eigene Client-Authentifizierung auf
Loopback erreichbar: lokale Programme können den hinterlegten Key über ihn nutzen.

### Umgebungsvariablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `20129` | Lokaler Listen-Port (1–65535) |
| `OMNIROUTE_BASE_URL` | Dateiwert, sonst `http://192.168.178.2:20128` | Überschreibt die Upstream-URL aus der Datei; optionaler Basispfad möglich |
| `PROXY_CONFIG_FILE` | `config.json` im Projektverzeichnis | Optionaler anderer Dateipfad; relative Pfade beziehen sich auf das Arbeitsverzeichnis |

Eine über `PROXY_CONFIG_FILE` ausdrücklich ausgewählte Datei muss vorhanden sein.

PowerShell:

```powershell
$env:PORT = '20129'
$env:OMNIROUTE_BASE_URL = 'http://192.168.178.2:20128'
npm start
```

POSIX-Shell:

```sh
PORT=20129 OMNIROUTE_BASE_URL=http://192.168.178.2:20128 npm start
```

Der Proxy lauscht bewusst **nur auf IPv4-Loopback `127.0.0.1`**, nicht auf allen
Netzwerkschnittstellen. Er implementiert keine eigene Authentifizierung und
keine eigene CORS-Logik. CORS-Header vom Upstream bleiben erhalten.
Die Upstream-URL darf keine Zugangsdaten, Query oder Fragment enthalten.
API-Keys gehören ins Feld `apiKey` oder in Request-Header, nicht in diese URL.

## OpenCode

Im vorhandenen OmniRoute-Provider die `baseURL` auf den Proxy ändern. Der gewünschte
Konfigurationsausschnitt lautet:

```json
{
  "settings": {
    "baseURL": "http://127.0.0.1:20129/v1",
    "apiKey": "{file:.omniroute-api-key}"
  }
}
```

Je nach OpenCode-Version/Provider liegt dieses Objekt unter `options` statt
`settings`; entscheidend sind dieselben Werte für `baseURL` und `apiKey`.
Die bestehende Provider-/Modellkonfiguration bleibt ansonsten unverändert.
Die Key-Datei nicht ins Repository einchecken.

Dieser OpenCode-Ausschnitt sendet weiterhin einen eigenen Key, der Vorrang vor
dem Datei-Key hat. Für den Datei-Fallback muss der Client ohne `Authorization`
und ohne `x-api-key` anfragen. Manche Clients verlangen zwingend einen Key;
ein von ihnen gesendeter Dummy-Key würde ebenfalls transparent weitergeleitet
und nicht durch den Datei-Key ersetzt.

`Authorization`, `x-api-key`, `anthropic-version`, `X-OmniRoute-*` und andere
End-to-end-Header werden an OmniRoute weitergeleitet. Request-Bodies bleiben
bytegenau erhalten, ohne JSON-Parsing oder Neuformatierung.

## Manueller Test

Eine Datei `request.json` lokal erstellen:

```json
{
  "model": "gpt-6.1-sol",
  "input": "Antworte nur mit OK",
  "stream": true
}
```

PowerShell: explizit `curl.exe` verwenden, da `curl` in Windows PowerShell 5.1
ein Alias sein kann. `<KEY>` durch den OmniRoute-Key ersetzen:

```powershell
curl.exe -N `
  -H "Authorization: Bearer <KEY>" `
  -H "Content-Type: application/json" `
  --data-binary "@request.json" `
  http://127.0.0.1:20129/v1/responses
```

POSIX-Shell:

```sh
curl -N \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  --data-binary "@request.json" \
  http://127.0.0.1:20129/v1/responses
```

Die Ausgabe darf nicht mehr mit dem oben gezeigten ungültigen Frame beginnen.
Erwarteter regulärer Beginn, sofern OmniRoute ihn so liefert:

```text
event: response.created
data: ...

```

Modellliste prüfen:

```powershell
curl.exe -H "Authorization: Bearer <KEY>" http://127.0.0.1:20129/v1/models
```

Mit einem gültigen `apiKey` in `config.json` kann der Auth-Header entfallen:

```powershell
curl.exe http://127.0.0.1:20129/v1/models
curl.exe -N -H "Content-Type: application/json" --data-binary "@request.json" http://127.0.0.1:20129/v1/responses
```

Für den nicht-streamenden Test in `request.json` lediglich `stream` auf `false`
setzen und denselben Aufruf wiederholen. JSON-Antworten werden ungefiltert
weitergegeben. Der tatsächliche OpenCode-/Provider-Test benötigt einen laufenden
OmniRoute und einen gültigen Key; die automatisierten Tests verwenden lokale Mocks.

## Filterregeln und Streaming

Ein vollständig abgegrenzter SSE-Frame wird nur entfernt, wenn **alle** Kriterien
zutreffen:

1. Noch kein `event: response.created` oder JSON-`data.type === "response.created"`
   beobachtet.
2. Kein `event`-Feld vorhanden (auch ein leeres Feld verhindert die Entfernung).
3. Die zusammengefügten `data:`-Zeilen enthalten gültiges JSON.
4. `data.type === "response.in_progress"` und `data.response.id === null`.

Andere Frames, ungültiges JSON und unvollständige Schlussframes bleiben erhalten.
Reguläre `response.in_progress`-Events werden nicht entfernt. Nach dem ersten
`response.created` werden sämtliche weiteren Bytes direkt weitergereicht.
Sequenznummern und Inhalte werden niemals verändert.

Unterstützt werden LF- und CRLF-Leerzeilen, auch über beliebige Chunk-Grenzen
hinweg. Originalbytes und Trenner aller erhaltenen Frames bleiben unverändert.
Vor `response.created` wird höchstens ein Frame gepuffert, niemals die gesamte
Response. Bei mehr als 1 MiB für einen einzelnen Initial-Frame wird konservativ
auf ungefilterte Weiterleitung umgeschaltet (Fail-open).

Native Streams respektieren Backpressure. Ein Client-Abbruch schließt auch
Upstream-Request/-Response. Es gibt keine kurzen Socket- oder Request-Body-
Timeouts für LLM-Streams. Die normalen Node.js-Header-/Keep-alive-Grenzen bleiben
bestehen. HTTP-Upstream-Fehler werden mit Status und Body weitergereicht;
Netzwerkfehler vor Response-Beginn ergeben `502` mit:

```json
{"error":{"message":"OmniRoute upstream unavailable","type":"proxy_error"}}
```

Bei Netzwerk-/Streamfehlern nach Response-Beginn wird die Verbindung beendet;
ein neuer HTTP-Status ist dann nicht mehr möglich.

## Header und Kompression

- Hop-by-hop-Header einschließlich durch `Connection` benannter Header werden
  entfernt. `Host` wird auf den Upstream angepasst. HTTP-Framing wird von Node.js
  neu erzeugt; Header-Großschreibung/Reihenfolge sind nicht garantiert.
- Nur für `POST /v1/responses` wird `Accept-Encoding: identity` angefordert,
  einschließlich nicht-streamender Requests auf dieser Route.
- Falls OmniRoute dies ignoriert, werden gzip/br/deflate-SSE-Antworten defensiv
  dekomprimiert und ungepackt gefiltert weitergegeben. Unbekannte Kompression
  wird vollständig unverändert durchgereicht statt beschädigt.
- Bei gefiltertem SSE entfallen `Content-Length` und Repräsentationsvalidatoren/
  Digests (`ETag`, `Content-MD5`, `Digest`, `Content-Digest`, `Repr-Digest`). Node.js
  verwendet Chunked Streaming. Sonstige End-to-end-Header bleiben erhalten.
- Nicht-SSE-Antworten und andere Routen bleiben ungefiltert, auch bei Kompression.

## Logging und Tests

Das kompakte Logging enthält Startadresse, konfigurierte Upstream-URL,
Netzwerk-/Streamfehlercodes und entfernte Initial-Frames. API-Keys, Authorization,
Prompts und vollständige Bodies werden nicht geloggt.

`npm test` verwendet den eingebauten Node.js-Test-Runner. Abgedeckt sind die
Filterfälle A–G, Chunk-Grenzen, CRLF, Unicode, konservative Randfälle und lokale
Mock-Upstreams für transparente Weiterleitung, HTTP-/Netzwerkfehler,
Live-Streaming, langsame Clients, Kompression sowie Client-Abbrüche während
Streaming und Upload. Weitere Tests prüfen Dateikonfiguration, sichere
Validierung, Umgebungsvariablen-Priorität und den Auth-Fallback.

Nicht-Ziele: OmniRoute/OpenCode patchen, Modelle oder Tool Calls ändern,
Reasoning-Parameter manipulieren, Events neu nummerieren oder beliebige
SSE-Protokollfehler korrigieren.
