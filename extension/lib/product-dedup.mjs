import { similar } from './fingerprint.mjs';
import { productImage } from './products.mjs';
import { hashImage } from './image-fingerprint.mjs';

export function duplicateItems(job) {
  return (job.groups || []).flatMap(group => (group.members || []).filter(item => item !== group.best && String(item.id) !== String(group.best.id)).map(item => ({item, representative:group.best})));
}
export function restoreDuplicate(job, id) {
  const found = duplicateItems(job).find(entry => String(entry.item.id) === String(id));
  if (!found) return false;
  const group = job.groups.find(group => group.best === found.representative);
  group.members = group.members.filter(item => item !== found.item);
  group.ids = group.members.map(item => item.id);
  found.item.dedupRestored = true;
  job.groups.push({ids:[found.item.id],best:found.item,members:[found.item],retained:true});
  job.merged = duplicateItems(job).length;
  return true;
}
export async function deduplicate(job, hash = hashImage, cancelled = () => false) {
  if (job.imageDedup !== true) return;
  const groups = [];
  const originals = new Map();
  for (const source of job.groups) {
    if (cancelled()) return;
    const itemCopy = {...source.best};
    originals.set(itemCopy, source.best);
    const group = {...source, ids:[...(source.ids || [])], best:itemCopy, members:[...(source.members || [source.best])]};
    const item = group.best;
    group.members ||= [item];
    group.members = group.members.map(member => String(member.id) === String(item.id) ? item : member);
    const url = item.originalListImage || productImage(item);
    if (!url) item.imageDedupNote = '未读到主图，未完成主图去重，已保留独立商品';
    if (url && item.imageHashUrl !== url) {
      try {
        const value = await hash(url);
        if (cancelled()) return;
        item.imageHash = value?.bits ? {fingerprint:value} : value; item.imageHashUrl = url; item.imageDedupNote = '';
      } catch {
        if (cancelled()) return;
        item.imageHashUrl = url; item.imageHash = null;
        item.imageDedupNote = '主图读取失败，已保留独立商品';
      }
    }
    const match = !item.dedupRestored && item.imageHash && groups.find(other => {
      const representative = other.best;
      if (representative.dedupRestored || !representative.imageHash) return false;
      return item.imageHash.sha256 && item.imageHash.sha256 === representative.imageHash.sha256 || similar(item.imageHash.fingerprint, representative.imageHash.fingerprint);
    });
    if (match) {
      match.members.push(...group.members); match.ids = match.members.map(member => member.id);
    } else groups.push(group);
  }
  if (cancelled()) return;
  // Keep product identities used by the runner while committing all staged state together.
  for (const [copy, original] of originals) Object.assign(original, copy);
  for (const group of groups) {
    group.best = originals.get(group.best);
    group.members = group.members.map(member => originals.get(member) || member);
  }
  job.groups = groups;
  job.merged = duplicateItems(job).length;
  job.imageDedupFailures = groups.filter(group => group.best.imageDedupNote).length;
}
