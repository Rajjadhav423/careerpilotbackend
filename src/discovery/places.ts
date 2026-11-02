/*
 * Turns free-text job locations ("Bengaluru, Karnataka, India", "Tokyo", "Remote - Germany",
 * "San Francisco, CA; New York, NY") into country + city, so Find jobs can filter by country and city.
 * Sources with structured locations (SmartRecruiters, Recruitee) pass country/city directly.
 */

export type Place = { country: string | null; city: string | null; remote: boolean };

/** Country display name → lower-case names and codes that mean it. */
const COUNTRIES: Record<string, string[]> = {
  India: ["india", "in", "ind", "bharat"],
  Japan: ["japan", "jp", "jpn", "nihon"],
  Germany: ["germany", "de", "deu", "deutschland"],
  "United States": ["united states", "united states of america", "usa", "us", "u.s.", "u.s.a."],
  "United Kingdom": ["united kingdom", "uk", "gb", "great britain", "england", "scotland", "wales", "northern ireland"],
  Canada: ["canada", "ca"],
  Ireland: ["ireland", "ie"],
  Netherlands: ["netherlands", "the netherlands", "nl", "holland"],
  France: ["france", "fr"],
  Spain: ["spain", "es", "españa"],
  Portugal: ["portugal", "pt"],
  Italy: ["italy", "it"],
  Poland: ["poland", "pl"],
  Austria: ["austria", "at", "österreich"],
  Switzerland: ["switzerland", "ch", "schweiz"],
  Sweden: ["sweden", "se"],
  Denmark: ["denmark", "dk"],
  Norway: ["norway", "no"],
  Finland: ["finland", "fi"],
  Belgium: ["belgium", "be"],
  "Czech Republic": ["czech republic", "czechia", "cz"],
  Romania: ["romania", "ro"],
  Greece: ["greece", "gr"],
  Turkey: ["turkey", "türkiye", "tr"],
  Israel: ["israel", "il"],
  "United Arab Emirates": ["united arab emirates", "uae", "ae"],
  Singapore: ["singapore", "sg"],
  Australia: ["australia", "au"],
  "New Zealand": ["new zealand", "nz"],
  Brazil: ["brazil", "br", "brasil"],
  Mexico: ["mexico", "mx", "méxico"],
  Argentina: ["argentina", "ar"],
  Colombia: ["colombia", "co"],
  "South Korea": ["south korea", "korea", "kr", "republic of korea"],
  China: ["china", "cn"],
  "Hong Kong": ["hong kong", "hk"],
  Taiwan: ["taiwan", "tw"],
  Philippines: ["philippines", "ph"],
  Indonesia: ["indonesia", "id"],
  Vietnam: ["vietnam", "viet nam", "vn"],
  Malaysia: ["malaysia", "my"],
  "South Africa": ["south africa", "za"],
  Nigeria: ["nigeria", "ng"],
  Egypt: ["egypt", "eg"],
  Ukraine: ["ukraine", "ua"],
  Estonia: ["estonia", "ee"],
  Lithuania: ["lithuania", "lt"],
  Hungary: ["hungary", "hu"],
};

const COUNTRY_BY_ALIAS = new Map<string, string>();
for (const [name, aliases] of Object.entries(COUNTRIES)) {
  for (const alias of aliases) COUNTRY_BY_ALIAS.set(alias, name);
}

/** Two-letter aliases are only trusted as the last part ("Pune, IN"), never as words in a sentence. */
const SHORT_CODE = /^[a-z]{2,3}$/;

/** Well-known cities → [display name, country]. Spellings and old names map to one city. */
const CITIES: Record<string, [string, string]> = {};
const city = (country: string, display: string, ...names: string[]) => {
  for (const name of [display.toLowerCase(), ...names]) CITIES[name] = [display, country];
};
// India
city("India", "Bengaluru", "bangalore", "bengaluru urban");
city("India", "Mumbai", "bombay", "navi mumbai");
city("India", "Delhi", "new delhi", "delhi ncr", "ncr");
city("India", "Gurugram", "gurgaon");
city("India", "Noida", "greater noida");
city("India", "Hyderabad", "secunderabad");
city("India", "Chennai", "madras");
city("India", "Pune", "poona");
city("India", "Kolkata", "calcutta");
city("India", "Ahmedabad");
city("India", "Kochi", "cochin");
city("India", "Jaipur");
city("India", "Coimbatore");
city("India", "Indore");
city("India", "Thiruvananthapuram", "trivandrum");
city("India", "Chandigarh");
city("India", "Nagpur");
city("India", "Mysuru", "mysore");
city("India", "Bhubaneswar");
// Japan
city("Japan", "Tokyo", "tokyo-to");
city("Japan", "Osaka");
city("Japan", "Kyoto");
city("Japan", "Yokohama");
city("Japan", "Fukuoka");
city("Japan", "Nagoya");
city("Japan", "Sapporo");
city("Japan", "Kobe");
// Germany
city("Germany", "Berlin");
city("Germany", "Munich", "münchen", "muenchen");
city("Germany", "Hamburg");
city("Germany", "Frankfurt", "frankfurt am main");
city("Germany", "Cologne", "köln", "koeln");
city("Germany", "Stuttgart");
city("Germany", "Düsseldorf", "dusseldorf", "duesseldorf");
city("Germany", "Leipzig");
city("Germany", "Dresden");
city("Germany", "Nuremberg", "nürnberg", "nuernberg");
city("Germany", "Karlsruhe");
city("Germany", "Hanover", "hannover");
city("Germany", "Bonn");
city("Germany", "Heidelberg");
// Elsewhere (common in tech postings)
city("United States", "San Francisco", "sf", "san francisco bay area", "bay area");
city("United States", "New York", "new york city", "nyc");
city("United States", "Seattle");
city("United States", "Mountain View");
city("United States", "Sunnyvale");
city("United States", "Palo Alto");
city("United States", "San Jose");
city("United States", "Austin");
city("United States", "Boston");
city("United States", "Chicago");
city("United States", "Los Angeles");
city("United States", "Denver");
city("United States", "Atlanta");
city("United States", "Washington, D.C.", "washington dc", "washington d.c.");
city("United Kingdom", "London");
city("United Kingdom", "Manchester");
city("United Kingdom", "Edinburgh");
city("Ireland", "Dublin");
city("Netherlands", "Amsterdam");
city("France", "Paris");
city("Spain", "Madrid");
city("Spain", "Barcelona");
city("Portugal", "Lisbon", "lisboa");
city("Poland", "Warsaw", "warszawa");
city("Poland", "Kraków", "krakow", "cracow");
city("Austria", "Vienna", "wien");
city("Switzerland", "Zurich", "zürich");
city("Sweden", "Stockholm");
city("Denmark", "Copenhagen", "københavn");
city("Singapore", "Singapore");
city("Australia", "Sydney");
city("Australia", "Melbourne");
city("Canada", "Toronto");
city("Canada", "Vancouver");
city("Canada", "Montreal", "montréal");
city("United Arab Emirates", "Dubai");
city("Israel", "Tel Aviv", "tel aviv-yafo");
city("Brazil", "São Paulo", "sao paulo");

/** US state codes, so "Austin, TX" is the United States (and "CA" after a city is California, not Canada). */
const US_STATES = new Set(("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc").split(" "));

const REMOTE = /\b(remote|anywhere|worldwide|work from home|wfh|distributed|global)\b/i;

function clean(value: string) {
  return value.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^\p{L}\p{N}.\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** One location segment, e.g. "Bengaluru, Karnataka, India" or "Remote - Germany". */
function parseSegment(segment: string): Place | null {
  const remote = REMOTE.test(segment);
  const parts = segment.split(/,|\s[-–|/]\s|\s\/\s/).map(clean)
    // "In Bangalore", "Based in Pune"
    .map((part) => part.replace(/^(based in|located in|in|at|near)\s+/, ""))
    .filter(Boolean);
  if (parts.length === 0) return remote ? { country: null, city: null, remote } : null;

  let country: string | null = null;
  // "IN" is Indiana and India, "CA" California and Canada: a known city decides
  let fromStateCode = false;
  // Country: a full name anywhere, or a code as the last part
  for (let i = parts.length - 1; i >= 0 && !country; i--) {
    const part = parts[i].replace(/\b(remote|anywhere|worldwide)\b/g, "").trim();
    const isLast = i === parts.length - 1;
    if (isLast && parts.length >= 2 && US_STATES.has(part)) {
      country = "United States";
      fromStateCode = true;
      break;
    }
    const match = COUNTRY_BY_ALIAS.get(part);
    if (match && (!SHORT_CODE.test(part) || (isLast && parts.length >= 2) || part.length > 3)) country = match;
  }

  // City: the first part that is a known city, else the first part that isn't a country/remote word
  let cityName: string | null = null;
  for (const part of parts) {
    const known = CITIES[part];
    if (known) {
      cityName = known[0];
      if (!country || fromStateCode) country = known[1];
      break;
    }
  }
  if (!cityName) {
    const first = parts[0].replace(/\b(remote|anywhere|worldwide|hybrid|on-?site)\b/g, "").trim();
    if (first && !COUNTRY_BY_ALIAS.has(first) && !US_STATES.has(first) && first.length <= 40 && country) {
      cityName = first.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    }
  }
  if (!country && !cityName && !remote) return null;
  return { country, city: cityName, remote };
}

/** All places in a location string ("Pune, India; Remote - Germany" → two places). */
export function parsePlaces(location: string | null | undefined): Place[] {
  if (!location) return [];
  const places = location.split(/;|\n|\s\|\s|\bor\b/).map((s) => parseSegment(s.trim())).filter((p): p is Place => p !== null);
  // Same place listed twice
  const seen = new Set<string>();
  return places.filter((p) => {
    const key = `${p.country}|${p.city}|${p.remote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A structured source's country (name or ISO code) as our display name. */
export function countryName(value: string | null | undefined): string | null {
  if (!value) return null;
  return COUNTRY_BY_ALIAS.get(clean(value)) ?? value.trim();
}

/** A structured source's city in our spelling ("Bangalore" → "Bengaluru"). */
export function cityName(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return CITIES[clean(value)]?.[0] ?? value.trim();
}
