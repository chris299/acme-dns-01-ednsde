# Fallback auf den konfigurierten Resolver, wenn Port 53 nach außen blockiert ist

[ADR 0002](./0002-propagation-selbst-verifizieren.md) setzt voraus, dass die autoritativen Nameserver
der Zone direkt befragt werden können. Das ist auf vielen Netzen nicht der Fall: auf dem
Entwicklungsrechner dieses Projekts laufen Abfragen an `8.8.8.8`, `1.1.1.1`, `9.9.9.9` _und_ an
`ns3`/`ns4.edns.de` alle in `ETIMEOUT`, nur die lokal konfigurierten Resolver antworten. Firmennetze
und Provider, die DNS abfangen, verhalten sich genauso. Ohne Rückfallebene ist das Plugin dort nicht
benutzbar — jede Ausstellung scheitert nach Ablauf des Zeitbudgets.

Antwortet in der ersten Poll-Runde **kein einziger** Nameserver, gilt das nicht als langsame
Propagation, sondern als Netz, das Port 53 nach außen nicht zulässt. Das Warten wechselt dann sofort
auf den konfigurierten Resolver, statt das Budget abzuwarten.

## Consequences

Im Fallback misst das Plugin nicht mehr die Wahrheit, sondern einen Cache — genau das, was ADR 0002
vermeiden wollte. Damit wird das SOA-Minimum von einer Randnotiz zur bestimmenden Größe, und daraus
folgt der zweite Teil dieser Entscheidung: **spät fragen statt oft fragen.**

Ein Challenge-Name existiert vor der ersten Ausstellung nicht. Eine Abfrage direkt nach dem Anlegen
bekommt NXDOMAIN, und der Resolver hält diese Antwort für das SOA-Minimum der Zone fest — bei
`winkler.tel` sind das 300 Sekunden. Eine sofortige erste Abfrage macht das Warten also _garantiert_
erfolglos, egal wie lange es dauert. Deshalb:

- die erste Abfrage erst nach 30 Sekunden, also nach der von eDNS gemessenen Propagationszeit von ~23 s
- danach im Abstand des SOA-Minimums, weil eine frühere Wiederholung nur den Cache erneut liest
- und das Zeitbudget aus dem SOA-Minimum der Zone abgeleitet, nicht aus `propagationTimeout`: ein
  kürzeres Budget kann im Fallback nicht erfolgreich sein

Das heißt auch: eine erste Ausstellung auf einem Host mit blockiertem Port 53 kann mehrere Minuten
dauern, wo sie mit direkten Abfragen nach ~23 Sekunden fertig ist. Das ist der Preis dafür, dass sie
überhaupt gelingt. `skipChallengeTest` bleibt trotzdem `true`: im Fallback fragen wir denselben
Resolver, den acme.js gefragt hätte, nur mit einem Budget und einer Fehlermeldung, die das
Cache-Verhalten kennen.

Die Fehlermeldung nennt in diesem Fall ausdrücklich den blockierten Port und das SOA-Minimum, dem sie
gefolgt ist — nicht die Propagation, die hier nicht die Ursache ist.
