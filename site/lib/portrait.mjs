// Staff portraits: one transparent PNG per cast member in static/cast/<id>.png.
export function portrait(m, root) {
  const name = String(m.name).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return '<img src="' + root + 'cast/' + m.id + '.png" alt="Portrait of the ' + name + '" width="512" height="512">';
}
