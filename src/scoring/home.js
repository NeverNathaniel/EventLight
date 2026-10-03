// "Close to home": how near an event's city is to your home city. Shows you
// already like get a boost that is full within FULL_MILES of home and fades
// to nothing by ZERO_MILES — so from Tacoma, Puyallup and Federal Way count
// as home, Kent about half, and Seattle (25 mi as the crow flies) not at all.
//
// Event sources only give a city name, so distances come from this table of
// Puget Sound city centers. A city missing from it only counts when it is
// your home city itself.

export const FULL_MILES = 8;
export const ZERO_MILES = 18;

// Boost strengths offered in Settings, as a percentage added to the score.
export const BOOST_LEVELS = [
  { value: 0, label: 'Off' },
  { value: 25, label: 'Light' },
  { value: 50, label: 'Medium' },
  { value: 100, label: 'Strong' },
];

const CITY_CENTERS = {
  auburn: [47.3073, -122.2285],
  'bainbridge island': [47.6262, -122.5212],
  bellevue: [47.6101, -122.2015],
  'bonney lake': [47.1773, -122.1865],
  bothell: [47.7623, -122.2054],
  bremerton: [47.5673, -122.6326],
  burien: [47.4704, -122.3468],
  'des moines': [47.4018, -122.3243],
  dupont: [47.0968, -122.6315],
  edmonds: [47.8107, -122.3774],
  enumclaw: [47.2043, -121.9915],
  everett: [47.979, -122.2021],
  'federal way': [47.3223, -122.3126],
  fife: [47.2393, -122.3571],
  fircrest: [47.2323, -122.516],
  'gig harbor': [47.3293, -122.5801],
  issaquah: [47.5301, -122.0326],
  kent: [47.3809, -122.2348],
  kirkland: [47.6815, -122.2087],
  lacey: [47.0343, -122.8232],
  lakewood: [47.1718, -122.5185],
  lynnwood: [47.8209, -122.3151],
  marysville: [48.0518, -122.1771],
  milton: [47.2481, -122.3129],
  monroe: [47.8554, -121.9709],
  mukilteo: [47.9445, -122.3046],
  olympia: [47.0379, -122.9007],
  parkland: [47.1554, -122.4343],
  'port orchard': [47.5404, -122.6363],
  poulsbo: [47.7359, -122.6465],
  puyallup: [47.1854, -122.2929],
  redmond: [47.674, -122.1215],
  renton: [47.4829, -122.2171],
  ruston: [47.2973, -122.5104],
  seattle: [47.6062, -122.3321],
  shoreline: [47.7557, -122.3415],
  silverdale: [47.6445, -122.6949],
  snoqualmie: [47.5287, -121.8254],
  spanaway: [47.104, -122.4346],
  steilacoom: [47.1698, -122.6026],
  sumner: [47.2032, -122.2404],
  suquamish: [47.7309, -122.5521],
  tacoma: [47.2529, -122.4443],
  tukwila: [47.474, -122.261],
  tumwater: [47.0073, -122.9093],
  'university place': [47.2357, -122.5504],
  vashon: [47.4473, -122.4599],
  woodinville: [47.7543, -122.1635],
  yelm: [46.942, -122.606],
};

// "Tacoma, WA" / " tacoma " → "tacoma".
export function cityKey(city) {
  return String(city || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,\s*(?:wa|washington)\.?$/, '');
}

// Cities with a known center, title-cased for a picker.
export function knownCities() {
  return Object.keys(CITY_CENTERS).map((k) => k.replace(/\b[a-z]/g, (c) => c.toUpperCase()));
}

function miles([lat1, lon1], [lat2, lon2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

// { factor: 0–1, miles } — factor is 1 at home, fading to 0 at ZERO_MILES.
// miles is null for your home city itself and for cities off the map.
export function proximity(city, home) {
  const c = cityKey(city);
  const h = cityKey(home);
  if (!c || !h) return { factor: 0, miles: null };
  if (c === h) return { factor: 1, miles: null };
  const a = CITY_CENTERS[c];
  const b = CITY_CENTERS[h];
  if (!a || !b) return { factor: 0, miles: null };
  const d = miles(a, b);
  const factor = d <= FULL_MILES ? 1 : d >= ZERO_MILES ? 0 : (ZERO_MILES - d) / (ZERO_MILES - FULL_MILES);
  return { factor, miles: Math.round(d) };
}
