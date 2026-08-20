# acme-dns-01-ednsde

Ein DNS-01-Challenge-Plugin für [acme.js](https://git.rootprojects.org/root/acme.js), das ACME-Challenges
über die eDNS-Challenge-API von edns.de löst. Es ist ein acme.js-Plugin und _hat_ einen Adapter zur
eDNS-API — nicht umgekehrt. Das Vokabular von acme.js ist daher kanonisch; eDNS-Begriffe existieren
nur an der API-Grenze.

## Language

### Challenge

**Challenge Record**:
Ein TXT-Record, der einer Certificate Authority beweist, dass wir eine Domain kontrollieren.
Das Einzige, was dieses Paket im DNS anlegt oder entfernt.
_Avoid_: TXT-Record (zu allgemein), Challenge-Token, ACME-Record

**Key Authorization Digest**:
Der Wert eines Challenge Records: der url-safe-base64-kodierte SHA-256 über die Key Authorization,
immer 43 Zeichen.
_Avoid_: Challenge Token, dnsAuthorization (in acme.js als deprecated markiert), Hash, Digest allein

**Presenter**:
Das Objekt, das dieses Paket per `create()` zurückgibt, mit den fünf Methoden, die acme.js aufruft.
acme.js' eigener Begriff für ein Challenge-Plugin.
_Avoid_: Challenger, Handler, Provider (Provider heißt in libdns etwas anderes)

### Namensraum

**Zone**:
Der DNS-Namensraum, für den ein Nameserver autoritativ ist — das, was ein eigenes SOA besitzt.
Der Teil eines Namens, den die eDNS-API als `domain` erwartet.
_Avoid_: Domain (in diesem Kontext mehrdeutig), Apex-Domain, Root-Domain, Basisdomain

**Prefix**:
Der Teil eines Hosts links der Zone, z.B. `_acme-challenge.foo` in `_acme-challenge.foo.example.com`.
Wird an die eDNS-API unverändert als `subdomain` gegeben; auf dem Zone-Apex entfällt er ganz.
_Avoid_: Subdomain (nur eDNS-API-seitig korrekt), Label, Name, Record-Name

**Host**:
Der vollständige Name des Challenge Records, also Prefix plus Zone. Das, was man mit `dig TXT` abfragt.
_Avoid_: FQDN, Domainname, Record

**Zone Cut**:
Die Grenze zwischen einer Zone und ihrer übergeordneten Zone. Sie zu finden ist die einzige Möglichkeit,
einen Host in Zone und Prefix zu zerlegen, da die eDNS-API keine Zonen auflisten kann.
_Avoid_: Delegation, Zonengrenze, Registrable Domain (das ist eine andere, schwächere Idee)

### eDNS-Grenze

**Access Token**:
Das Geheimnis, mit dem sich dieses Paket bei der eDNS-Challenge-API ausweist. Ein Token kann für
mehrere Zonen gelten.
_Avoid_: API-Key, Credential, Passwort

**Zone Assignment**:
Die im eDNS-Webinterface pro Zone vorgenommene Freigabe eines Access Tokens. Ohne sie ist ein
gültiges Token für diese Zone wertlos, und die API unterscheidet das nicht von einem ungültigen Token.
_Avoid_: Berechtigung, Freigabe, Scope

### Sichtbarkeit

**Propagation**:
Die Zeit, bis ein Challenge Record von allen autoritativen Nameservern der Zone ausgeliefert wird.
Bei eDNS beim Anlegen kurz, beim Entfernen etwa so lang wie die TTL.
_Avoid_: Verteilung, Sync, Replikation

**Negative Cache**:
Die Zwischenspeicherung der Antwort „dieser Name existiert nicht" für die Dauer des SOA-Minimums der
Zone. Der Grund, warum eine _erste_ Ausstellung scheitern kann, obwohl der Record längst gesetzt ist.
_Avoid_: NXDOMAIN-Cache, DNS-Cache
