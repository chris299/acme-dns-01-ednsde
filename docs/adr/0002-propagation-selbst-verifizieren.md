# Propagation selbst gegen autoritative Nameserver verifizieren

acme.js prüft vor dem Challenge-Abschluss selbst per `dns.resolveTxt` über den OS-Resolver, ob der
Challenge Record sichtbar ist — eine Messung, die am Negative Cache scheitert, weil der Challenge-Name
vor der ersten Ausstellung nicht existiert und diese Antwort für die Dauer des SOA-Minimums gilt.
Statt auf ein pauschales `propagationDelay` zu warten, pollt `set()` daher die autoritativen
Nameserver der Zone direkt, bis alle den erwarteten Key Authorization Digest ausliefern; danach meldet
das Plugin `skipChallengeTest = true` und `propagationDelay = 0`.

## Consequences

Autoritativ zu fragen ist die einzige Messung, die nicht von fremden Caches abhängt — weder vom
OS-Resolver noch von öffentlichen Resolvern wie 1.1.1.1. ioBroker.acme unterstützt `skipChallengeTest`
bereits (eingeführt für Netcup), das Plugin muss dort also nichts erzwingen. Umgekehrt heißt das: der
Adapter darf sein generisches `dns01PpropagationDelay` nicht über unsere 0 schreiben — die
Sonderfallbehandlung, die dort für Netcup existiert, muss dieses Paket mit einschließen.

## Nachtrag: `skipChallengeTest` ist ein Hinweis, keine Voraussetzung

Der Hook existiert erst ab ioBroker.acme 3.0.0; ältere Adapter ignorieren ihn und überschreiben unsere
`propagationDelay = 0` mit ihrem Default von 120000. Das Plugin verlässt sich deshalb nicht darauf: es
pollt ausschließlich autoritativ und wartet bewusst _nicht_ zusätzlich darauf, dass der System-Resolver
den Record sieht. Auf den System-Resolver zu warten hieße, sich freiwillig an den Negative Cache zu
ketten — mit unbegrenzter Wartezeit und nichtssagender Fehlermeldung im Fehlerfall. Auf alten Adaptern
deckt die zusätzliche Wartezeit den OS-Resolver in der Praxis mit ab: langsamer, aber korrekt.
