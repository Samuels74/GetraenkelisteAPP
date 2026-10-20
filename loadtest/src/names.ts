/**
 * Name pools for the generated persons: common Austrian/German names plus the
 * names of a mixed Viennese population. Many carry diacritics (ä ö ü ß é á č
 * š ř …) so the diacritics-insensitive person search of the SPA
 * (frontend/src/lib/search.ts: NFD + strip combining marks) is exercised.
 * Only letters that decompose under NFD are used (no ı, đ, ø), apart from ß,
 * which the app deliberately keeps as is.
 */
import type { Random } from './random.ts';

export const FIRST_NAMES: readonly string[] = [
  // women
  'Anna', 'Maria', 'Elisabeth', 'Katharina', 'Theresa', 'Johanna', 'Sophie', 'Lena', 'Laura', 'Sarah',
  'Julia', 'Lisa', 'Hannah', 'Magdalena', 'Barbara', 'Christina', 'Sabine', 'Andrea', 'Petra', 'Claudia',
  'Monika', 'Karin', 'Brigitte', 'Gabriele', 'Renate', 'Ingrid', 'Ursula', 'Helga', 'Gertrude', 'Waltraud',
  'Bärbel', 'Käthe', 'Stefanie', 'Veronika', 'Susanne', 'Daniela', 'Nicole', 'Alexandra', 'Michaela', 'Viktoria',
  'Valentina', 'Leonie', 'Emilia', 'Marlene', 'Rosa', 'Zoë', 'Renée', 'Chloé', 'Noémi', 'Ágnes',
  'Éva', 'Ivana', 'Mirjana', 'Nikolina', 'Gül', 'Ayşe', 'Elif', 'Zeynep', 'Anna-Lena', 'Eva-Maria',
  // men
  'Johann', 'Josef', 'Franz', 'Karl', 'Leopold', 'Georg', 'Michael', 'Thomas', 'Andreas', 'Stefan',
  'Christian', 'Markus', 'Martin', 'Peter', 'Wolfgang', 'Gerhard', 'Helmut', 'Herbert', 'Manfred', 'Günther',
  'Jürgen', 'Jörg', 'Björn', 'Sören', 'Lukas', 'Maximilian', 'Florian', 'Sebastian', 'Tobias', 'Matthias',
  'Alexander', 'David', 'Paul', 'Felix', 'Jonas', 'Elias', 'Jakob', 'Moritz', 'Simon', 'Fabian',
  'Dominik', 'Daniel', 'Philipp', 'Valentin', 'Ferdinand', 'Rupert', 'Alois', 'Friedrich', 'Rudolf', 'Anton',
  'Hubert', 'Walter', 'Ernst', 'Mehmet', 'Ömer', 'Ümit', 'Goran', 'Miloš', 'Tomáš', 'Jiří',
  'Hans-Peter', 'Karl-Heinz',
];

export const LAST_NAMES: readonly string[] = [
  'Gruber', 'Huber', 'Bauer', 'Wagner', 'Müller', 'Pichler', 'Steiner', 'Moser', 'Mayer', 'Hofer',
  'Leitner', 'Berger', 'Fuchs', 'Eder', 'Fischer', 'Schmid', 'Winkler', 'Weber', 'Schwarz', 'Maier',
  'Schneider', 'Reiter', 'Mayr', 'Schmidt', 'Wimmer', 'Egger', 'Brunner', 'Lang', 'Baumgartner', 'Auer',
  'Binder', 'Lechner', 'Wolf', 'Wallner', 'Aigner', 'Ebner', 'Koller', 'Lehner', 'Haas', 'Schuster',
  'Holzer', 'Wieser', 'Stadler', 'Strasser', 'Kaiser', 'Hofmann', 'Riegler', 'Gasser', 'Hackl', 'Kofler',
  'Böhm', 'Jäger', 'Krämer', 'Schütz', 'Hölzl', 'Pöll', 'Weiß', 'Groß', 'Strauß', 'Fröhlich',
  'Hübner', 'Kößler', 'Mühlbacher', 'Pröll', 'Rößler', 'Stöger', 'Zöchling', 'Dörfler', 'Füreder', 'Hörmann',
  'Lämmerhofer', 'Nöbauer', 'Pühringer', 'Würfl', 'Ölz', 'Übleis', 'Ärmühlbacher', 'Haßlinger', 'Meßner', 'Größbacher',
  'Özdemir', 'Öztürk', 'Kovačević', 'Petrović', 'Novák', 'Dvořák', 'Horváth', 'Szabó', 'Kovács', 'Nagy',
  'Mayer-Hofer', 'Schmid-Pöll', 'Huber-Gruber', 'Lindner', 'Rainer', 'Bacher', 'Thaler', 'Grabner', 'Seidl', 'Wurm',
];

/** Typical (often Austrian) short forms; looked up by the first part of the first name. */
const NICKNAMES: Readonly<Record<string, readonly string[]>> = {
  Anna: ['Anni', 'Annerl'], Maria: ['Mitzi', 'Mia'], Elisabeth: ['Sissi', 'Lisi'], Katharina: ['Kathi'],
  Theresa: ['Resi'], Johanna: ['Hanni'], Magdalena: ['Leni'], Barbara: ['Babsi'], Christina: ['Tina'],
  Sabine: ['Bine'], Monika: ['Moni'], Brigitte: ['Gitti'], Gabriele: ['Gabi'], Ursula: ['Uschi'],
  Gertrude: ['Trude'], Waltraud: ['Traudl'], Bärbel: ['Bärli'], Stefanie: ['Steffi'], Veronika: ['Vroni'],
  Susanne: ['Susi'], Daniela: ['Dani'], Nicole: ['Nici'], Alexandra: ['Alex'], Michaela: ['Michi'],
  Viktoria: ['Vicky'], Valentina: ['Vali'], Eva: ['Evi'],
  Johann: ['Hansi', 'Hans'], Josef: ['Sepp', 'Pepi'], Franz: ['Franzi'], Karl: ['Charly'], Leopold: ['Poldi'],
  Georg: ['Schurli', 'Schorsch'], Michael: ['Michi'], Thomas: ['Tom'], Andreas: ['Andi'], Stefan: ['Steff'],
  Christian: ['Chris'], Martin: ['Tini'], Wolfgang: ['Wolfi'], Gerhard: ['Gerri'], Helmut: ['Helmi'],
  Herbert: ['Herbie'], Manfred: ['Manni'], Günther: ['Günni'], Jürgen: ['Jürgi'], Lukas: ['Luki'],
  Maximilian: ['Maxi'], Florian: ['Flo'], Sebastian: ['Wastl', 'Basti'], Tobias: ['Tobi'], Matthias: ['Hias'],
  Alexander: ['Xandi'], Jakob: ['Jaki'], Dominik: ['Domi'], Daniel: ['Dani'], Philipp: ['Phil'],
  Valentin: ['Valli'], Ferdinand: ['Ferdl'], Rupert: ['Rupi'], Alois: ['Luis'], Friedrich: ['Fritz'],
  Rudolf: ['Rudi'], Anton: ['Toni'], Hubert: ['Hubsi'], Walter: ['Wally'], Ernst: ['Ernstl'], Hans: ['Hansi'],
};

/** For persons without a typical short form (and sometimes instead of it). */
const GENERIC_NICKNAMES: readonly string[] = [
  'Bärli', 'Mausi', 'Spatzl', 'Chef', 'Doc', 'Kapitän', 'Lucky', 'Sunny', 'Tiger', 'Fuchsi', 'Zwergerl',
  'Rakete', 'Wirbelwind', 'Ötzi', 'Schmähtandler', 'Gourmet', 'Weinkenner', 'Kaffeetante', 'Frühaufsteher',
  'Stammgast', 'Nachtschwärmer', 'Dirigent', 'Präsident', 'Goalie',
];

export interface GeneratedName {
  name: string;
  nickname: string;
}

/** A full name ("Vorname Nachname") and, with the given probability, a nickname. */
export function generateName(random: Random, nicknameRate: number): GeneratedName {
  const firstName = random.pick(FIRST_NAMES);
  const lastName = random.pick(LAST_NAMES);
  let nickname = '';
  if (random.chance(nicknameRate)) {
    const typical = NICKNAMES[firstName.split('-')[0] as string];
    nickname = typical && random.chance(0.75) ? random.pick(typical) : random.pick(GENERIC_NICKNAMES);
  }
  return { name: `${firstName} ${lastName}`, nickname };
}
