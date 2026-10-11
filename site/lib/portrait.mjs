// Placeholder portraits drawn as SVG from each member's `art` entry in content/cast.json.
export function portrait(m) {
  var a = m.art, skin = a.skin, hair = a.hair, shirt = a.shirt, dark = '#1B2631';
  var hairSvg = {
    short: '<path d="M40 50 Q40 28 60 28 Q80 28 80 50 Q76 38 60 38 Q44 38 40 50Z" fill="' + hair + '"/>',
    long: '<path d="M38 56 Q36 26 60 26 Q84 26 82 56 L82 76 Q76 72 76 54 Q74 38 60 38 Q46 38 44 54 Q44 72 38 76Z" fill="' + hair + '"/>',
    bun: '<circle cx="60" cy="22" r="9" fill="' + hair + '"/><path d="M40 50 Q40 28 60 28 Q80 28 80 50 Q76 38 60 38 Q44 38 40 50Z" fill="' + hair + '"/>',
    curly: '<g fill="' + hair + '"><circle cx="44" cy="36" r="9"/><circle cx="56" cy="30" r="9"/><circle cx="68" cy="30" r="9"/><circle cx="78" cy="38" r="9"/><circle cx="41" cy="48" r="6"/><circle cx="80" cy="48" r="6"/></g>',
    bob: '<path d="M38 62 Q34 26 60 26 Q86 26 82 62 L76 62 Q76 40 60 40 Q44 40 44 62Z" fill="' + hair + '"/>',
    none: ''
  }[a.style] || '';
  var face = '<circle cx="53" cy="54" r="2.2" fill="' + dark + '"/><circle cx="67" cy="54" r="2.2" fill="' + dark + '"/><path d="M53 64 Q60 69 67 64" fill="none" stroke="' + dark + '" stroke-width="2" stroke-linecap="round"/>';
  var acc = ACC[m.id] ? ACC[m.id](a) : '';
  var front = a.accFront ? acc : '';
  var back = a.accFront ? '' : acc;
  return '<svg viewBox="0 0 120 120" role="img" aria-label="Portrait of the ' + m.name + '" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M14 120 Q14 88 42 84 L78 84 Q106 88 106 120Z" fill="' + shirt + '"/>' +
    '<path d="M52 78 H68 V88 Q60 94 52 88Z" fill="' + skin + '"/>' +
    '<ellipse cx="60" cy="54" rx="20" ry="24" fill="' + skin + '"/>' +
    (a.hairBack ? hairSvg : '') + back + (a.hairBack ? '' : hairSvg) + face + front + '</svg>';
}
const ACC = {
  gatekeeper: function () { return '<path d="M37 45 Q60 14 83 45Z" fill="#1E3A5F"/><rect x="34" y="43" width="52" height="6" rx="3" fill="#13253D"/><circle cx="60" cy="33" r="4" fill="#E0B341"/><circle cx="82" cy="100" r="6" fill="#E0B341"/><path d="M82 96v8M78 100h8" stroke="#13253D" stroke-width="1.5"/>'; },
  keymaster: function () { return '<circle cx="60" cy="100" r="8" fill="none" stroke="#D9A927" stroke-width="3"/><rect x="58" y="108" width="4" height="10" fill="#D9A927"/><rect x="62" y="113" width="5" height="3" fill="#D9A927"/><rect x="62" y="108" width="5" height="3" fill="#D9A927"/>'; },
  executive: function () { return '<path d="M42 86 L60 100 L78 86 L72 84 L60 94 L48 84Z" fill="#F2F4F5"/><path d="M57 94 L63 94 L65 118 L60 120 L55 118Z" fill="#C4301C"/><path d="M14 120 Q14 88 42 84 L52 90 L40 120Z M106 120 Q106 88 78 84 L68 90 L80 120Z" fill="#14202B" opacity=".55"/>'; },
  secretary: function () { return '<path d="M39 54 Q36 28 60 27 Q84 28 81 54" fill="none" stroke="#243746" stroke-width="3.5"/><rect x="34" y="50" width="7" height="13" rx="3" fill="#243746"/><path d="M38 63 Q42 72 54 72" fill="none" stroke="#243746" stroke-width="2.5"/><circle cx="55" cy="72" r="2.6" fill="#243746"/><rect x="82" y="92" width="16" height="22" rx="2" fill="#F5F0DD" stroke="#243746" stroke-width="1.5"/><path d="M86 98h8M86 103h8M86 108h5" stroke="#243746" stroke-width="1.2"/>'; },
  landlord: function () { return '<path d="M37 46 Q60 12 83 46Z" fill="#F2B01E"/><rect x="33" y="44" width="54" height="6" rx="3" fill="#E09A00"/><rect x="57" y="22" width="6" height="22" fill="#E09A00"/><rect x="82" y="96" width="14" height="10" rx="2" fill="#8A6B3F"/><circle cx="89" cy="96" r="4" fill="none" stroke="#8A6B3F" stroke-width="2"/>'; },
  auditor: function () { return '<g fill="none" stroke="#1B2631" stroke-width="2.4"><circle cx="51" cy="54" r="8"/><circle cx="69" cy="54" r="8"/><path d="M59 54h2"/></g><circle cx="90" cy="98" r="8" fill="none" stroke="#3B4B58" stroke-width="3"/><path d="M96 104l8 8" stroke="#3B4B58" stroke-width="3.5" stroke-linecap="round"/>'; },
  treasurer: function () { return '<path d="M36 46 L84 46 L90 53 L30 53Z" fill="#2E8B57"/><rect x="38" y="36" width="44" height="10" fill="#2E8B57" opacity=".5"/><text x="60" y="108" text-anchor="middle" font-family="Archivo, Arial" font-weight="800" font-size="18" fill="#E0B341">$</text>'; },
  bouncer: function () { return '<rect x="40" y="48" width="18" height="10" rx="3" fill="#0B1218"/><rect x="62" y="48" width="18" height="10" rx="3" fill="#0B1218"/><path d="M58 52h4" stroke="#0B1218" stroke-width="2.4"/><path d="M80 56 Q92 62 90 80 Q88 90 80 92" fill="none" stroke="#7A8791" stroke-width="2"/><rect x="26" y="86" width="68" height="34" fill="#0F1A24" opacity=".35"/>'; },
  timekeeper: function () { return '<circle cx="60" cy="102" r="12" fill="#F5F6F7" stroke="#8A6B3F" stroke-width="3"/><path d="M60 102V94M60 102l6 3" stroke="#1B2631" stroke-width="2" stroke-linecap="round"/><path d="M72 96 Q86 90 86 80" fill="none" stroke="#8A6B3F" stroke-width="1.8"/>'; },
  registrar: function () { return '<path d="M60 90 L48 84 L48 96Z M60 90 L72 84 L72 96Z" fill="#7B2D8E"/><circle cx="60" cy="90" r="3.4" fill="#5A1F69"/><g fill="none" stroke="#1B2631" stroke-width="2.2"><rect x="43" y="49" width="14" height="10" rx="3"/><rect x="63" y="49" width="14" height="10" rx="3"/><path d="M57 53h6"/></g><rect x="82" y="98" width="14" height="14" rx="2" fill="#C4301C"/><path d="M85 105h8" stroke="#fff" stroke-width="2"/>'; },
  inspector: function () { return '<path d="M38 44 Q60 20 82 44Z" fill="#2B4A3A"/><rect x="35" y="42" width="50" height="5" rx="2.5" fill="#1C3328"/><circle cx="60" cy="35" r="5" fill="#FFE27A" stroke="#1C3328" stroke-width="2"/><path d="M30 120 L38 90 L46 90 L44 120Z M90 120 L82 90 L74 90 L76 120Z" fill="#E8F26A"/><rect x="40" y="105" width="40" height="3" fill="#E8F26A"/>'; }
};

