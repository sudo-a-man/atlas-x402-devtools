# Atlas x402 Dev-Utility API

Open-source, self-hostable pay-per-call developer utilities over the
[x402](https://x402.org) payment protocol (USDC on Base). No signup, no API key.
Unpaid requests return `HTTP 402` with machine-readable payment requirements;
paid requests settle fail-closed through the x402.org facilitator.

## Endpoints

14 payable routes plus free discovery/health endpoints.

| Method | Path | Price (USD) | Description |
|--------|------|-------------|-------------|
| POST | `/qr` | 0.002 | QR code image from text/URL |
| POST | `/barcode` | 0.002 | Linear barcode (CODE128, EAN, UPC, …) |
| POST | `/qr/wifi` | 0.004 | WiFi-join QR (SSID/password/encryption) |
| POST | `/qr/vcard` | 0.004 | Contact (vCard) QR |
| POST | `/qr/sepa` | 0.004 | SEPA credit-transfer QR |
| POST | `/qr/event` | 0.004 | Calendar event (iCal VEVENT) QR |
| POST | `/barcode/validate` | 0.002 | Validate UPC/EAN/GTIN check digit |
| POST | `/qr/batch` | 0.004 | Batch QR generation |
| POST | `/convert/csv2json` | 0.002 | CSV → JSON (RFC4180-ish) |
| POST | `/convert/json2csv` | 0.002 | JSON → CSV |
| POST | `/convert/yaml2json` | 0.002 | YAML → JSON (safe JSON schema) |
| POST | `/convert/json2yaml` | 0.002 | JSON → YAML |
| POST | `/pdf/document` | 0.01 | Simple PDF document from text blocks |
| POST | `/pdf/table` | 0.01 | PDF table from rows/columns |

Free endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness + version |
| GET | `/stats` | Usage + revenue metering |
| GET | `/` | HTML docs/landing |
| GET | `/.well-known/x402` | Machine-readable x402 catalog |
| GET | `/openapi.json` | OpenAPI 3.1 spec |

## Run locally

```bash
npm install
PAY_TO=0xYourWalletAddress npm start   # listens on :8080
```

Environment variables:

- `PAY_TO` — destination wallet address for settled payments (Base).
- `PORT` — listen port (default `8080`).
- `PUBLIC_URL` — optional; the base URL advertised in the x402 catalog.

## Docker

```bash
docker build -t atlas-x402-devtools .
docker run -p 8080:8080 -e PAY_TO=0xYourWalletAddress atlas-x402-devtools
```

## Payment flow (x402)

1. Client calls a payable route with no payment → server responds `402` with an
   `accepts` array describing the required `exact` payment (amount, network, pay-to).
2. Client signs an EIP-3009 `TransferWithAuthorization` and retries with an
   `X-PAYMENT` header.
3. Server verifies and settles via the x402.org facilitator. On success it
   returns the generated artifact; on failure it returns `402` again (fail-closed).

## Tests

```bash
npm test   # node --test; mock-facilitator paid happy-path + fail-closed checks
```

## License

MIT
