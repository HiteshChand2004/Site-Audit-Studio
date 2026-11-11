import { useRef, useState } from 'react';
import { ImagePlus, LoaderCircle, Trash2 } from 'lucide-react';
import Button from '../common/Button.jsx';
import { Alert } from '../common/Surface.jsx';
import { api } from '../../api/client.js';
import form from '../common/Form.module.css';
import styles from './BusinessDetails.module.css';
import { DETAIL_FIELDS, IMAGE_RULES, fieldProblem } from './details.js';

// Build mode: what only the owner knows about their business. The details form (name and phone needed for a new site) and
// their photos and logo, stored with the saved site on the server (server/src/buildmode/images.js), never in its state.

/**
 * The details form. required: name and phone are marked as needed (a new site); otherwise every field is optional.
 */
export function DetailsFields({ details, setDetails, required = false }) {
  const set = (id, value) => setDetails((d) => ({ ...d, [id]: value }));
  return (
    <div className={styles.grid}>
      {DETAIL_FIELDS.map((f) => {
        const problem = fieldProblem(f.id, details[f.id]);
        const needed = required && f.required;
        const common = {
          className: f.multiline ? `${form.input} ${styles.area}` : form.input,
          value: details[f.id],
          placeholder: f.placeholder,
          maxLength: f.max,
          required: needed || undefined,
          'aria-invalid': problem ? 'true' : undefined,
          'aria-describedby': problem ? `detail-${f.id}-problem` : undefined,
          onChange: (e) => set(f.id, e.target.value),
        };
        return (
          <label key={f.id} className={`${form.field} ${f.wide ? styles.wide : ''}`}>
            <span className={form.label}>{f.label}{!needed && <span className={form.optional}>optional</span>}</span>
            {f.multiline
              ? <textarea {...common} rows={2} />
              : <input {...common} inputMode={f.inputMode} autoComplete={f.autoComplete} />}
            {problem && <span id={`detail-${f.id}-problem`} className={styles.problem}>{problem}</span>}
          </label>
        );
      })}
    </div>
  );
}

const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Why a picked file cannot be added, in the owner's words, or ''. */
const fileProblem = (file) => {
  if (!IMAGE_RULES.types.includes(file.type)) return `${file.name}: only JPEG, PNG or WebP pictures can be added.`;
  if (file.size > IMAGE_RULES.bytes) return `${file.name} is larger than ${mb(IMAGE_RULES.bytes)}. Choose a smaller copy.`;
  return '';
};

/**
 * The owner's logo and photos, each with a short description (its alt text on the site).
 * images: [{ id, role, alt, width, height }] in the site's state; ensureSite(): the saved site's id, creating it first when it is
 * new; currentSite(): the site open now, so a slow upload never lands in another site.
 */
export function PhotoPicker({ siteId, images, setImages, ensureSite, currentSite }) {
  const [adding, setAdding] = useState(0);
  const [problems, setProblems] = useState([]);
  const logoInput = useRef(null);
  const photoInput = useRef(null);
  const logo = images.find((i) => i.role === 'logo');
  const photos = images.filter((i) => i.role === 'photo');
  const room = IMAGE_RULES.photos - photos.length;

  const add = async (fileList, role) => {
    const files = [...fileList];
    const found = [];
    let ok = files.filter((f) => {
      const p = fileProblem(f);
      if (p) found.push(p);
      return !p;
    });
    if (role === 'photo' && ok.length > room) {
      found.push(`Only ${IMAGE_RULES.photos} photos can be added: ${plural(ok.length - room, 'photo was', 'photos were')} left out.`);
      ok = ok.slice(0, Math.max(0, room));
    }
    if (role === 'logo') ok = ok.slice(0, 1);
    setProblems(found);
    if (!ok.length) return;
    setAdding(ok.length);
    try {
      const id = await ensureSite();
      // A new logo takes the old one's place.
      if (role === 'logo' && logo) {
        await api.deleteBuildImage(id, logo.id).catch((err) => { if (err.status !== 404) throw err; });
        if (currentSite() === id) setImages((list) => list.filter((i) => i.id !== logo.id));
      }
      for (const file of ok) {
        try {
          const stored = await api.uploadBuildImage(id, file, role);
          if (currentSite() !== id) return;
          setImages((list) => [...list, { id: stored.id, role: stored.role, alt: '', width: stored.width, height: stored.height }]);
        } catch (err) {
          found.push(`${file.name}: ${err.message}`);
        } finally {
          setAdding((n) => Math.max(0, n - 1));
        }
      }
    } catch (err) {
      found.push(err.message);
    } finally {
      setAdding(0);
      setProblems([...found]);
    }
  };

  const remove = async (image) => {
    setProblems([]);
    try {
      await api.deleteBuildImage(siteId, image.id);
    } catch (err) {
      if (err.status !== 404) {
        setProblems([err.message]);
        return;
      }
    }
    setImages((list) => list.filter((i) => i.id !== image.id));
  };
  const describe = (image, alt) => setImages((list) => list.map((i) => (i.id === image.id ? { ...i, alt } : i)));

  const tile = (image, label) => (
    <li key={image.id} className={styles.tile}>
      <img className={styles.thumb} src={api.buildImageUrl(siteId, image.id)} alt="" width={image.width ?? undefined} height={image.height ?? undefined} />
      <label className={styles.alt}>
        <span className="visually-hidden">{label}</span>
        <input
          className={form.input}
          value={image.alt}
          maxLength={IMAGE_RULES.alt}
          placeholder={image.role === 'logo' ? 'e.g. Trattoria Rosa logo' : 'What is in it? e.g. Our wood-fired oven'}
          onChange={(e) => describe(image, e.target.value)}
        />
      </label>
      <Button size="sm" variant="ghost" icon={Trash2} iconOnly onClick={() => remove(image)}>Remove {image.alt || label}</Button>
    </li>
  );

  return (
    <div className={styles.photos}>
      <div className={styles.group}>
        <div className={styles.groupHead}>
          <span className={form.label}>Your logo<span className={form.optional}>optional</span></span>
          <Button size="sm" icon={ImagePlus} disabled={adding > 0} onClick={() => logoInput.current?.click()}>{logo ? 'Replace the logo' : 'Add your logo'}</Button>
        </div>
        {logo && <ul className={styles.tiles}>{tile(logo, 'Describe your logo')}</ul>}
      </div>
      <div className={styles.group}>
        <div className={styles.groupHead}>
          <span className={form.label}>Photos<span className={form.optional}>optional · {photos.length} of {IMAGE_RULES.photos}</span></span>
          <Button size="sm" icon={ImagePlus} disabled={adding > 0 || room <= 0} onClick={() => photoInput.current?.click()}>Add photos</Button>
        </div>
        {(photos.length > 0 || adding > 0) && (
          <ul className={styles.tiles}>
            {photos.map((p, i) => tile(p, `Describe photo ${i + 1}`))}
            {adding > 0 && (
              <li className={`${styles.tile} ${styles.pending}`} aria-live="polite">
                <LoaderCircle size={18} className={styles.spin} aria-hidden="true" />
                <span>Adding {plural(adding, 'picture', 'pictures')}…</span>
              </li>
            )}
          </ul>
        )}
      </div>
      <p className={styles.note}>
        Real photos of your place, your work or your team make the site yours: the plan builds sections around them. JPEG, PNG or WebP, up to {mb(IMAGE_RULES.bytes)} each.
        A few words about each one are read out to visitors who cannot see it, and help search engines.
      </p>
      {problems.length > 0 && (
        <Alert tone="warn" title="Some pictures were not added">
          <ul className={styles.problems}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Alert>
      )}
      <input ref={logoInput} type="file" accept={IMAGE_RULES.types.join(',')} className="visually-hidden" tabIndex={-1} aria-hidden="true"
        onChange={(e) => { const files = [...(e.target.files ?? [])]; if (files.length) add(files, 'logo'); e.target.value = ''; }} />
      <input ref={photoInput} type="file" accept={IMAGE_RULES.types.join(',')} multiple className="visually-hidden" tabIndex={-1} aria-hidden="true"
        onChange={(e) => { const files = [...(e.target.files ?? [])]; if (files.length) add(files, 'photo'); e.target.value = ''; }} />
    </div>
  );
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
