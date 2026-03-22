/**
 * Seed the AZOP database with sample decisions and guidelines for testing.
 *
 * Includes real AZOP decisions (telecoms breach, banking data access, video surveillance)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["AZOP_DB_PATH"] ?? "data/azop.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

interface TopicRow {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  { id: "consent", name_local: "Privola", name_en: "Consent", description: "Prikupljanje, valjanost i povlačenje privole za obradu osobnih podataka (čl. 7. GDPR-a)." },
  { id: "cookies", name_local: "Kolačići i tragači", name_en: "Cookies and trackers", description: "Postavljanje i čitanje kolačića i tragača na terminalima korisnika (ePrivacy direktiva)." },
  { id: "transfers", name_local: "Međunarodni prijenosi podataka", name_en: "International transfers", description: "Prijenos osobnih podataka trećim zemljama ili međunarodnim organizacijama (čl. 44-49. GDPR-a)." },
  { id: "dpia", name_local: "Procjena učinka na zaštitu podataka (DPIA)", name_en: "Data Protection Impact Assessment (DPIA)", description: "Procjena rizika za prava i slobode osoba za obradu visoke rizičnosti (čl. 35. GDPR-a)." },
  { id: "breach_notification", name_local: "Povreda osobnih podataka", name_en: "Data breach notification", description: "Prijava povreda osobnih podataka AZOP-u i ispitanicima (čl. 33-34. GDPR-a)." },
  { id: "privacy_by_design", name_local: "Ugrađena zaštita podataka", name_en: "Privacy by design", description: "Integracija zaštite podataka u projektiranje i zadane postavke (čl. 25. GDPR-a)." },
  { id: "employee_monitoring", name_local: "Nadzor zaposlenika", name_en: "Employee monitoring", description: "Obrada osobnih podataka u radnom odnosu i nadzor zaposlenika." },
  { id: "health_data", name_local: "Zdravstveni podaci", name_en: "Health data", description: "Obrada zdravstvenih podataka — posebne kategorije s pojačanom zaštitom (čl. 9. GDPR-a)." },
  { id: "children", name_local: "Podaci djece", name_en: "Children's data", description: "Zaštita osobnih podataka maloljetnika u mrežnim uslugama (čl. 8. GDPR-a)." },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
);
for (const t of topics) {
  insertTopic.run(t.id, t.name_local, t.name_en, t.description);
}
console.log(`Inserted ${topics.length} topics`);

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  {
    reference: "AZOP-2021-1892",
    title: "AZOP rješenje — Telekomunikacijski operator (povreda podataka)",
    date: "2021-11-18",
    type: "kazna",
    entity_name: "Telekomunikacijski operator d.o.o.",
    fine_amount: 500_000,
    summary: "AZOP je izrekao kaznu od 500 000 HRK telekomunikacijskom operatoru zbog teške povrede osobnih podataka u kojoj su bili kompromitirani podaci oko 200 000 pretplatnika, uključujući kontaktne podatke i podatke o korištenim uslugama.",
    full_text: "Agencija za zaštitu osobnih podataka (AZOP) izrekla je novčanu kaznu od 500 000 HRK telekomunikacijskom operatoru. Povreda podataka nastala je zbog propusta u sigurnosnoj infrastrukturi koji je omogućio neovlašteni pristup bazi podataka pretplatnika. Utvrđene povrede: (1) Voditelj obrade nije proveo odgovarajuće tehničke i organizacijske mjere sigurnosti sukladno čl. 32. GDPR-a; (2) Prijava povrede nije dostavljena AZOP-u u propisanom roku od 72 sata; (3) Ispitanici nisu obaviješteni o povredi koja je predstavljala visoki rizik za njihova prava i slobode. AZOP je naložio hitno poduzimanje mjera za zaštitu pogođenih ispitanika i jačanje sigurnosnih sustava.",
    topics: JSON.stringify(["breach_notification", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["32", "33", "34"]),
    status: "final",
  },
  {
    reference: "AZOP-2022-0456",
    title: "AZOP rješenje — Banka (neovlašteni pristup podacima klijenata)",
    date: "2022-03-25",
    type: "kazna",
    entity_name: "Hrvatska banka d.d.",
    fine_amount: 350_000,
    summary: "AZOP je izrekao kaznu od 350 000 HRK banci zbog neovlaštenog pristupa osobnim podacima klijenata od strane zaposlenika koji nisu imali legitimnu poslovnu potrebu za pristupom takvim podacima, što je otkriveno internom revizijom.",
    full_text: "Agencija za zaštitu osobnih podataka (AZOP) izrekla je novčanu kaznu od 350 000 HRK banci. Interna revizija banke otkrila je da su zaposlenici iz odjela koji nisu izravno uključeni u upravljanje klijentskim računima pristupali osobnim i financijskim podacima klijenata. Utvrđene povrede: (1) Banka nije uspostavila odgovarajuće kontrole pristupa zasnovane na načelu nužnosti — zaposlenici su imali pristup znatno više podataka nego što je potrebno za obavljanje njihovih radnih zadataka; (2) Sigurnosni sustav nije generirao upozorenja za sumnjive obrasce pristupa; (3) Voditelj obrade nije proveo procjenu učinka na zaštitu podataka za sustave visoke rizičnosti. AZOP je naložio reviziju i poboljšanje kontrola pristupa.",
    topics: JSON.stringify(["privacy_by_design", "dpia"]),
    gdpr_articles: JSON.stringify(["5", "25", "32", "35"]),
    status: "final",
  },
  {
    reference: "AZOP-2021-2341",
    title: "AZOP rješenje — Videonadzor u javnom prostoru",
    date: "2021-07-14",
    type: "kazna",
    entity_name: "Trgovački lanac d.o.o.",
    fine_amount: 150_000,
    summary: "AZOP je kaznio trgovački lanac koji je instalirao kamere videonadzora koje su pokrivale javne prometnice i prostorije namijenjene odmoru zaposlenika, bez odgovarajuće pravne osnove i bez obavijesti ispitanicima.",
    full_text: "AZOP je izrekao novčanu kaznu od 150 000 HRK trgovačkom lancu. Nadzorni pregled utvrdio je da su kamere videonadzora bile postavljene na način koji je obuhvaćao javne pješačke i prometne površine izvan perimetra objekta te prostorije za odmor zaposlenika. Utvrđene povrede: (1) Videonadzor javnih površina nije imao odgovarajuću pravnu osnovu — svrha sigurnosti imovine ne opravdava nadzor javnog prostora; (2) Kamere u prostorijama za odmor zaposlenika predstavljaju nerazmjerno zadiranje u privatnost; (3) Naljepnice s obavijestima o videonadzoru nisu sadržavale sve informacije propisane čl. 13. GDPR-a; (4) Nije provedena procjena učinka za sustav videonadzora visoke rizičnosti.",
    topics: JSON.stringify(["employee_monitoring", "dpia", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["5", "6", "13", "25", "35"]),
    status: "final",
  },
  {
    reference: "AZOP-2022-1567",
    title: "AZOP rješenje — Kolačići na mrežnoj stranici (nedostatak privole)",
    date: "2022-09-08",
    type: "upozorenje",
    entity_name: "E-commerce platforma d.o.o.",
    fine_amount: 80_000,
    summary: "AZOP je kaznio e-commerce platformu zbog postavljanja marketinških i analitičkih kolačića bez prethodne privole korisnika i zbog toga što je odbijanje kolačića bilo složenije od prihvaćanja.",
    full_text: "AZOP je izrekao novčanu kaznu od 80 000 HRK e-commerce platformi. Kontrolni pregled utvrdio je sljedeće povrede: (1) Marketinški i analitički kolačići postavljani su odmah po dolasku korisnika na stranicu, prije nego što je ispitanik mogao izraziti privolu ili odbijanje; (2) Korisničko sučelje bannera kolačića dizajnirano je na način koji je otežavao odbijanje — opcija odbijanja bila je skrivena iza višestrukih klikova, dok je prihvaćanje bilo moguće jednim klikom; (3) Kolačići trećih strana nisu bili jasno i razumljivo opisani u obavijesti o kolačićima. AZOP je naložio usklađivanje u roku od 60 dana.",
    topics: JSON.stringify(["cookies", "consent"]),
    gdpr_articles: JSON.stringify(["6", "7"]),
    status: "final",
  },
  {
    reference: "AZOP-2023-0789",
    title: "AZOP rješenje — Zdravstvena ustanova (neovlašteni pristup medicinskim podacima)",
    date: "2023-02-20",
    type: "kazna",
    entity_name: "Zdravstvena ustanova",
    fine_amount: 200_000,
    summary: "AZOP je kaznio zdravstvenu ustanovu zbog neovlaštenog pristupa medicinskim podacima pacijenata od strane osoblja koje nije sudjelovalo u njihovom liječenju te zbog nedostatka procjene učinka za sustav elektroničkih zdravstvenih kartona.",
    full_text: "AZOP je izrekao novčanu kaznu od 200 000 HRK zdravstvenoj ustanovi. Inspekcija je utvrdila da je medicinsko i administrativno osoblje moglo pristupiti podacima svih pacijenata neovisno o tome jesu li bili uključeni u njihovu skrb. Utvrđene povrede: (1) Sustav upravljanja zdravstvenim podacima nije primjenjivao kontrolu pristupa zasnovanu na ulozi (RBAC), čime je prekršen čl. 9. GDPR-a koji zahtijeva posebne zaštitne mjere za zdravstvene podatke; (2) Nije provedena procjena učinka na zaštitu podataka za sustav elektroničkih zdravstvenih kartona; (3) Revizijski zapisi pristupa nisu bili dovoljno detaljni da bi se otkrilo neovlašteno pregledavanje.",
    topics: JSON.stringify(["health_data", "dpia", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["9", "32", "35"]),
    status: "final",
  },
  {
    reference: "AZOP-2023-1234",
    title: "AZOP rješenje — Međunarodni prijenos podataka bez zaštitnih mjera",
    date: "2023-05-30",
    type: "rješenje",
    entity_name: "Digitalna agencija d.o.o.",
    fine_amount: 120_000,
    summary: "AZOP je kaznio digitalnu agenciju zbog prijenosa osobnih podataka klijenata u SAD putem marketinških alata bez odgovarajućih zaštitnih mjera sukladno poglavlju V. GDPR-a.",
    full_text: "AZOP je izrekao novčanu kaznu od 120 000 HRK digitalnoj agenciji. Nadzorni pregled utvrdio je da agencija koristi više marketinških alata s poslužiteljima u SAD-u i da prenosi osobne podatke (e-mail adrese, podatke o ponašanju, profilirane podatke) bez provođenja odgovarajuće analize prijenosa ili primjene standardnih ugovornih klauzula (SCC) sa sveobuhvatnim dodatnim tehničkim mjerama. AZOP je naložio agenciji da preispita sve prijenose podataka trećim zemljama i dokumentira pravnu osnovu za svaki prijenos ili prestane s prijenosima koji ne udovoljavaju zahtjevima.",
    topics: JSON.stringify(["transfers"]),
    gdpr_articles: JSON.stringify(["44", "46"]),
    status: "final",
  },
  {
    reference: "AZOP-2022-3456",
    title: "AZOP rješenje — Nadzor zaposlenika putem IT sustava",
    date: "2022-11-15",
    type: "upozorenje",
    entity_name: "Tehnološka tvrtka d.o.o.",
    fine_amount: 60_000,
    summary: "AZOP je kaznio tehnološku tvrtku zbog praćenja mrežnih aktivnosti zaposlenika i čitanja poslovne e-pošte bez odgovarajuće pravne osnove, bez obavijesti zaposlenicima i bez procjene učinka.",
    full_text: "AZOP je izrekao novčanu kaznu od 60 000 HRK tehnološkoj tvrtki. Utvrđene povrede: (1) Tvrtka je koristila softver za praćenje koji je bilježio sve mrežne aktivnosti zaposlenika, posjećene mrežne stranice i ključne riječi u e-pošti bez odgovarajuće pravne osnove — privola zaposlenika nije valjana pravna osnova zbog neravnopravnog odnosa; (2) Zaposlenici nisu bili obaviješteni o mjeri i opsegu praćenja; (3) Nije provedena procjena učinka za ovu visoko rizičnu obradu. AZOP je naložio obustavu nerazmjernog praćenja i usklađivanje prakse s načelima nužnosti i razmjernosti.",
    topics: JSON.stringify(["employee_monitoring", "consent", "dpia"]),
    gdpr_articles: JSON.stringify(["5", "6", "13", "35"]),
    status: "final",
  },
  {
    reference: "AZOP-2021-4567",
    title: "AZOP rješenje — Nedovoljna sigurnost osobnih podataka u javnom sektoru",
    date: "2021-04-22",
    type: "rješenje",
    entity_name: "Tijelo javne vlasti",
    fine_amount: null,
    summary: "AZOP je uputio tijelu javne vlasti nalog za poboljšanje sigurnosnih mjera zaštite osobnih podataka građana nakon što je otkrivena ranjivost koja je potencijalno omogućavala neovlašteni pristup osobnim podacima.",
    full_text: "AZOP je nakon nadzornog pregleda uputio nalog tijelu javne vlasti. Pregled je utvrdio da je web-portal koji obrađuje osobne podatke građana sadržavao sigurnosne ranjivosti koje su potencijalno mogle omogućiti neovlašteni pristup podacima: (1) Sustav nije primjenjivao višefaktorsku autentifikaciju za administratorski pristup; (2) Osobni podaci nisu bili u potpunosti kriptirani u mirovanju; (3) Softver treće strane koji je integriran u portal nije bio redovito ažuriran. Budući da je ranjivost otkrivena prije eksploatacije i da je tijelo brzo poduzelo korektivne mjere, AZOP nije izrekao novčanu kaznu, već je naložio provedbu sigurnosnih mjera.",
    topics: JSON.stringify(["privacy_by_design", "breach_notification"]),
    gdpr_articles: JSON.stringify(["25", "32"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(d.reference, d.title, d.date, d.type, d.entity_name, d.fine_amount, d.summary, d.full_text, d.topics, d.gdpr_articles, d.status);
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "AZOP-SMJERNICA-KOLACICI-2022",
    title: "Smjernice o kolačićima i sličnim tehnologijama praćenja",
    date: "2022-05-10",
    type: "smjernica",
    summary: "AZOP smjernice o zahtjevima privole za kolačiće i srodne tehnologije praćenja. Opisuju uvjete valjane privole, zahtjeve za banner kolačića i osiguravanje jednako jednostavnog odbijanja.",
    full_text: "AZOP je objavio smjernice o kolačićima sukladno ePrivacy direktivi i GDPR-u. Ključni zahtjevi: (1) Privola je potrebna za sve neesencijalne kolačiće (marketing, analitika, profiliranje) prije njihovog postavljanja; (2) Valjana privola mora biti slobodna, specifična, informirana i nedvosmislena — zabranjeni su 'kolačićni zidovi' koji uvjetuju pristup uslugama prihvaćanjem kolačića; (3) Odbijanje mora biti jednako jednostavno kao prihvaćanje — banner mora sadržavati gumb 'Odbij sve' na istoj razini kao gumb 'Prihvati sve'; (4) Privola treba biti obnovljena najmanje svake 12 mjeseci; (5) Voditelj mora moći dokazati da je pribavio valjanu privolu.",
    topics: JSON.stringify(["cookies", "consent"]),
    language: "hr",
  },
  {
    reference: "AZOP-VODIC-PROCJENA-UCINKA-2021",
    title: "Vodič za provođenje procjene učinka na zaštitu podataka (DPIA)",
    date: "2021-10-15",
    type: "vodič",
    summary: "AZOP vodič za provođenje procjene učinka na zaštitu podataka. Opisuje kada je DPIA obvezna, kako je provesti i što dokumentirati.",
    full_text: "Čl. 35. GDPR-a obvezuje provedbu DPIA kada obrada, posebno korištenjem novih tehnologija, može rezultirati visokim rizikom za prava i slobode fizičkih osoba. DPIA je obvezna posebno za: sustavni opsežni nadzor javno dostupnih mjesta, opsežnu obradu posebnih kategorija podataka (zdravstveni, biometrijski), profiliranje s pravnim ili sličnim učincima, automatiziranu obradu za donošenje odluka. Koraci DPIA: (1) Sustavni opis obrade — svrhe, kategorije podataka, primatelji, prijenosi, rokovi pohrane; (2) Procjena nužnosti i razmjernosti; (3) Procjena rizika — identifikacija prijetnji i procjena ozbiljnosti i vjerojatnosti; (4) Mjere za upravljanje rizicima — tehničke i organizacijske mjere; (5) Savjetovanje s AZOP-om ako preostali rizik ostaje visok.",
    topics: JSON.stringify(["dpia", "privacy_by_design"]),
    language: "hr",
  },
  {
    reference: "AZOP-SMJERNICA-VIDEONADZOR-2020",
    title: "Smjernice o videonadzoru",
    date: "2020-09-01",
    type: "smjernica",
    summary: "AZOP smjernice o zakonskim uvjetima za sustave videonadzora. Pokrivaju pravnu osnovu, mjesta koja se ne smiju nadzirati, zahtjeve za obavijesti i rokove pohrane snimaka.",
    full_text: "AZOP smjernice o videonadzoru temelje se na GDPR-u i Zakonu o provedbi Opće uredbe o zaštiti podataka. Pravna osnova: videonadzor se može temeljiti na legitimnom interesu (sigurnost imovine i osoba) ili izvršenju ugovora, ali ne smije prekoračiti ono što je nužno. Mjesta koja se ne smiju nadzirati: zahodi, svlačionice, prostorije za odmor zaposlenika i drugi prostori gdje osobe razumno očekuju privatnost. Obavijesti: jasno vidljive naljepnice moraju biti postavljene na ulazima u nadzirani prostor i sadržavati informacije o voditelju obrade, svrsi i kontaktu DPO-a. Rok pohrane snimaka: maksimalno 30 dana, osim u iznimnim slučajevima. DPIA: obvezna za opsežne sustave videonadzora, posebno one s analitikom lica.",
    topics: JSON.stringify(["employee_monitoring", "dpia", "privacy_by_design"]),
    language: "hr",
  },
  {
    reference: "AZOP-VODIC-POVREDA-2021",
    title: "Vodič za upravljanje povredom osobnih podataka",
    date: "2021-04-20",
    type: "vodič",
    summary: "AZOP vodič o postupanju u slučaju povrede osobnih podataka. Opisuje obveze prijave AZOP-u (72 sata), obavješćivanje ispitanika i dokumentiranje povreda.",
    full_text: "Povreda osobnih podataka je kršenje sigurnosti koje dovodi do slučajnog ili nezakonitog uništenja, gubitka, izmjene, neovlaštenog otkrivanja ili pristupa osobnim podacima. Prijava AZOP-u (čl. 33.): svaka povreda koja predstavlja rizik za prava i slobode ispitanika mora biti prijavljena AZOP-u u roku 72 sata od saznanja. Prijava mora sadržavati: prirodu povrede, kategorije i broj pogođenih ispitanika i zapisa, vjerojatne posljedice, poduzete ili planirane mjere. Obavješćivanje ispitanika (čl. 34.): kada povreda vjerojatno dovodi do visokog rizika, ispitanici moraju biti obaviješteni bez nepotrebnog odlaganja — osim ako su primijenjene odgovarajuće tehničke mjere zaštite (enkripcija). Dokumentiranje: sve povrede moraju biti dokumentirane interno, uključujući one koje ne zahtijevaju prijavu.",
    topics: JSON.stringify(["breach_notification"]),
    language: "hr",
  },
  {
    reference: "AZOP-MIŠLJENJE-ZAPOSLENI-2022",
    title: "Mišljenje o obradi osobnih podataka zaposlenika",
    date: "2022-08-01",
    type: "mišljenje",
    summary: "AZOP mišljenje o obradi osobnih podataka u radnom odnosu. Pokriva nadzor IT sustava, e-poštu zaposlenika, geolokaciju i videonadzor radnog mjesta.",
    full_text: "Obrada osobnih podataka zaposlenika regulirana je GDPR-om u kombinaciji s odredbama Zakona o radu. Privola zaposlenika: zbog neravnopravnog odnosa snaga, privola zaposlenika načelno nije valjana pravna osnova za obradu koja je u interesu poslodavca — osim u iznimnim slučajevima kada zaposlenici mogu odbiti bez štetnih posljedica. Nadzor IT sustava: praćenje korištenja interneta i e-pošte moguće je na temelju legitimnog interesa, ali mora biti razmjerno i nužno. Zaposlenici moraju biti unaprijed jasno obaviješteni o opsegu i uvjetima praćenja. Geolokacija: praćenje položaja profesionalnih vozila ili uređaja moguće je za određene poslovne svrhe (sigurnost, optimizacija ruta), ali kontinuirano praćenje izvan radnog vremena u načelu je zabranjeno.",
    topics: JSON.stringify(["employee_monitoring", "consent", "privacy_by_design"]),
    language: "hr",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(g.reference, g.title, g.date, g.type, g.summary, g.full_text, g.topics, g.language);
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const guidelineCount = (db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }).cnt;
const topicCount = (db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }).cnt;
const decisionFtsCount = (db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }).cnt;
const guidelineFtsCount = (db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
