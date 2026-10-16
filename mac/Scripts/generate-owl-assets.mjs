#!/usr/bin/env node
// One vector master produces the native drawing and all review SVGs. No font/color changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marks = JSON.parse(readFileSync(`${root}/assets/owls/marks.json`, 'utf8'));
const studies = JSON.parse(readFileSync(`${root}/assets/owls/wing-studies.json`, 'utf8'));
const eyeStudies = JSON.parse(readFileSync(`${root}/assets/owls/eye-studies.json`, 'utf8'));
const selection = JSON.parse(readFileSync(`${root}/assets/owls/selection.json`, 'utf8'));
const reviewMarks = { ...marks, ...Object.fromEntries(Object.entries(studies).map(([name, study]) => [name, {
  ...marks.refined, ...study, cutout: [...marks.refined.cutout.slice(0, 2), study.beak],
}])) };
Object.assign(reviewMarks, Object.fromEntries(Object.entries(eyeStudies).map(([name, study]) => [name, {
  ...reviewMarks.refined_tucked, ...study, pupilCutout: study.pupilCutout ?? [], cutout: [...study.eyes, reviewMarks.refined_tucked.beak],
}])));
if (!reviewMarks[selection.style] || reviewMarks[selection.style].label !== selection.label) {
  throw new Error('Selected owl must match an existing named variation.');
}
const nativeMarks = { ...marks, [selection.style]: reviewMarks[selection.style] };
const svgShape = s => s[0] === 'ellipse'
  ? `<ellipse cx="${s[1]}" cy="${s[2]}" rx="${s[3]}" ry="${s[4]}"/>`
  : `<path d="${s.map(c => c.join(' ')).join(' ')}"/>`;
const svg = (name, appIcon = false, tiny = false) => {
  const m = reviewMarks[name];
  // Eye/wing cutouts stay transparent in the standalone mark and macOS template image.
  const pupils = m.pupilCutout?.length
    ? `<g mask="url(#pupils)">${m.pupils.map(svgShape).join('')}</g>`
    : m.pupils.map(svgShape).join('');
  const pupilMask = m.pupilCutout?.length
    ? `<mask id="pupils"><rect width="100" height="100" fill="white"/><g fill="black">${m.pupilCutout.map(svgShape).join('')}</g></mask>`
    : '';
  const drawing = `<defs>${pupilMask}<mask id="face"><rect width="100" height="100" fill="white"/><g fill="black">${[...m.cutout, ...(tiny ? [] : m.detail)].map(svgShape).join('')}</g></mask></defs><g fill="#F5D76E"><g mask="url(#face)">${m.solid.map(svgShape).join('')}</g>${pupils}</g>`;
  return appIcon
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="${name === selection.style ? '#191527' : '#1A1528'}"/><g transform="translate(90 55) scale(3.32)">${drawing}</g><text x="60" y="460" font-family="Futura, Avenir Next, Helvetica Neue, sans-serif" font-weight="bold" font-size="38" letter-spacing="7" fill="#F5D76E">EXE</text></svg>\n`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="${m.label.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">${drawing}</svg>\n`;
};
const swiftShape = s => s[0] === 'ellipse'
  ? `ellipse(${s.slice(1).join(', ')})`
  : `path { p in\n${s.map(c => {
    const [op,...v] = c;
    const point = (x,y) => `CGPoint(x: ${x}, y: ${y})`;
    if (op === 'Z') return '            p.closeSubpath()';
    if (op === 'M') return `            p.move(to: ${point(...v)})`;
    if (op === 'L') return `            p.addLine(to: ${point(...v)})`;
    if (op === 'Q') return `            p.addQuadCurve(to: ${point(v[2],v[3])}, control: ${point(v[0],v[1])})`;
    if (op === 'C') return `            p.addCurve(to: ${point(v[4],v[5])}, control1: ${point(v[0],v[1])}, control2: ${point(v[2],v[3])})`;
    throw Error(`Unknown command ${op}`);
  }).join('\n')}\n        }`;
let source = `// Generated from assets/owls/marks.json, wing-studies.json and selection.json.\nimport AppKit\n\nenum OwlStyle: String, CaseIterable {\n    case ${Object.keys(nativeMarks).join(', ')}\n    static var selected: OwlStyle {\n        OwlStyle(rawValue: ProcessInfo.processInfo.environment["EXE_WATCHER_OWL_STYLE"] ?? "") ?? .${selection.style}\n    }\n}\n\nenum OwlArtwork {\n    static func image(size: CGFloat, style: OwlStyle = .selected, color: NSColor = .black, isTemplate: Bool = true) -> NSImage {\n        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in\n            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }\n            ctx.saveGState()\n            ctx.translateBy(x: 0, y: size)\n            ctx.scaleBy(x: size / 100, y: -size / 100)\n            ctx.setFillColor(color.cgColor)\n            func ellipse(_ x: CGFloat, _ y: CGFloat, _ rx: CGFloat, _ ry: CGFloat) {\n                ctx.fillEllipse(in: CGRect(x: x-rx, y: y-ry, width: 2*rx, height: 2*ry))\n            }\n            func path(_ build: (CGMutablePath) -> Void) {\n                let p = CGMutablePath(); build(p); ctx.addPath(p); ctx.fillPath()\n            }\n            switch style {\n`;
for (const [name, m] of Object.entries(nativeMarks)) {
  writeFileSync(`${root}/assets/owls/${name}.svg`, svg(name));
  writeFileSync(`${root}/assets/owls/${name}-menubar.svg`, svg(name, false, true));
  writeFileSync(`${root}/assets/owls/${name}-app.svg`, svg(name, true));
  source += `            case .${name}:\n                ${m.solid.map(swiftShape).join('\n                ')}\n                ctx.setBlendMode(.clear)\n                ${m.cutout.map(swiftShape).join('\n                ')}\n`;
  if(m.detail.length) source += `                if size >= 24 {\n                    ${m.detail.map(swiftShape).join('\n                    ')}\n                }\n`;
  source += `                ctx.setBlendMode(.normal)\n                ${m.pupils.map(swiftShape).join('\n                ')}\n`;
  if (m.pupilCutout?.length) source += `                ctx.setBlendMode(.clear)\n                ${m.pupilCutout.map(swiftShape).join('\n                ')}\n`;
}
source += `            }\n            ctx.restoreGState()\n            return true\n        }\n        image.isTemplate = isTemplate\n        return image\n    }\n}\n`;
writeFileSync(`${root}/mac/Sources/ExeWatcherMenubar/Theme/OwlArtwork.swift`, source);
for (const name of [...Object.keys(studies), ...Object.keys(eyeStudies)]) {
  writeFileSync(`${root}/assets/owls/${name}.svg`, svg(name));
  writeFileSync(`${root}/assets/owls/${name}-menubar.svg`, svg(name, false, true));
  writeFileSync(`${root}/assets/owls/${name}-app.svg`, svg(name, true));
}
writeFileSync(`${root}/assets/owls/selected.svg`, svg(selection.style));
writeFileSync(`${root}/assets/owls/selected-menubar.svg`, svg(selection.style, false, true));
writeFileSync(`${root}/assets/owls/selected-app.svg`, svg(selection.style, true));
const mark = svg(selection.style).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
writeFileSync(`${root}/assets/owl-header.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200" width="800" height="200">\n  <rect width="800" height="200" rx="16" fill="#1A1528"/>\n  <g transform="translate(341.2500, 40.3687) scale(1.175)">${mark}</g>\n  <text x="28" y="184" font-family="Futura, Avenir Next, Helvetica Neue, sans-serif" font-weight="bold" font-size="18" letter-spacing="4" fill="#F5D76E">EXE</text>\n</svg>\n`);
console.log('Generated owl artwork, three wing/beak variations and three eye variations.');
