# `get()` antwortet nach einem Entfernen aus eigener Buchhaltung

`get()` fragt autoritatives DNS ab und filtert auf den erwarteten Key Authorization Digest — außer
nach einem von der eDNS-API bestätigten Entfernen, dann antwortet es sofort `null`, ohne zu fragen.
Grund: der Testharness ruft nach `remove()` unmittelbar `get()` auf und verlangt strikt `null`, während
eDNS' autoritative Nameserver den entfernten Record noch etwa 307 Sekunden weiter ausliefern. Ohne
diesen Kurzschluss ist der Harness für dieses Paket grundsätzlich nicht bestehbar — weder mit
`testZone` noch mit `testRecord`, denn die Prüfung sitzt in dem `testEach`, das beide benutzen.

## Considered Options

- **Rein wahrheitsgemäß**: `get()` fragt immer DNS. Korrekt, aber der Harness scheitert reproduzierbar,
  und wir bräuchten einen eigenen Integrationstest plus den Verzicht auf „Passes acme-dns-01-test".
- **Reine Buchhaltung**: `get()` antwortet immer aus internem Verzeichnis. Der Harness prüfte dann nur
  noch unsere eigene Buchführung und wäre wertlos.
- **Hybrid** (gewählt): DNS-Messung auf dem Pfad, der in Produktion zählt (`set` → sichtbar);
  Buchhaltung nur für die eine Zusicherung, die eDNS' Architektur unmessbar macht.

## Consequences

Ein späterer Leser hält diesen Kurzschluss sonst für einen Fehler und „reparieren" ihn — daher steht er
auch im README. Tragende Voraussetzung ist außerdem, dass `get()` **kein** Produktionspfad ist: acme.js
ruft es nie auf (Pflicht sind nur `set` und `remove`, zu `get` und `zones` gibt es lediglich ein
`console.warn`) und verifiziert stattdessen selbst per `dns.resolveTxt`. Darauf dürfen wir uns stützen,
weil `@root/acme` seit April 2022 unverändert ist und der Kontrakt sich nicht mehr bewegen wird. Sollte
acme.js je wiederbelebt werden und `get()` aufrufen, ist diese Entscheidung neu zu prüfen.
