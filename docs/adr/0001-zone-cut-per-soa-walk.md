# Zone Cut per SOA-Walk statt Konfiguration

Die eDNS-Challenge-API verlangt Zone und Prefix getrennt (`domain` und `subdomain`), bietet aber
keinen Endpoint, der Zonen auflistet — und acme.js liefert `dnsZone`/`dnsPrefix` nur dann, wenn
`zones()` echte Zonen zurückgibt (es hängt den abgefragten Hosts absichtlich zwei Zufallszeichen
voran, damit ein Plugin nicht einfach die Hosts durchreichen kann). Wir ermitteln den Zone Cut daher
zur Laufzeit per DNS: vom Host label-weise aufwärts, bis eine Ebene ein eigenes SOA hat.

## Considered Options

- **Explizite Konfiguration** (`zones: ['example.com']`): verlässlich, aber der Nutzer müsste seine
  Zonenliste doppelt pflegen, und in ioBroker.acme bräuchte es ein zusätzliches Konfigurationsfeld,
  das der Adapter für alle Provider mitschleppt.
- **Public Suffix List**: bringt eine Dependency mit und liefert falsche Ergebnisse, sobald bei eDNS
  eine delegierte Subzone wie `sub.example.com` liegt — der Zone Cut liegt dann nicht dort, wo die
  Registrable Domain endet.
- **SOA-Walk** (gewählt): keine Dependency, kein Konfigurationsfeld, und korrekt auch bei delegierten
  Subzonen, weil er die tatsächliche Zonengrenze misst statt sie zu erraten.

## Consequences

Ein Plugin, das nach außen nur eine HTTP-API aufruft, löst intern DNS auf. Das überrascht beim Lesen,
ist aber die Bedingung dafür, dass die Zerlegung stimmt. `zones` bleibt als optionaler Override
erhalten, damit Sonderfälle nicht am Resolver hängen. Wildcard-Identifier erreichen `zones()` in der
Form `ab.*.example.com`; `*`-Labels müssen beim Walk entfernt werden.
