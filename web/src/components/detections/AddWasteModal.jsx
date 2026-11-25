import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AppNotice from '../common/AppNotice';
import { acknowledgeAction, confirmThenRun } from '../../stores/useNoticeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

function apiError(err, fallback) {
  const data = err?.response?.data;
  if (typeof data?.message === 'string' && data.message) return data.message;
  const first = data?.errors && Object.values(data.errors).flat()[0];
  return first || err?.message || fallback;
}

export default function AddWasteModal({
  open,
  kind,
  defaultCategoryId,
  stacked = false,
  onClose,
  onCreated,
}) {
  const catalog = useSettingsStore((s) => s.wasteCatalog);
  const addWasteCategory = useSettingsStore((s) => s.addWasteCategory);
  const addWasteClassification = useSettingsStore((s) => s.addWasteClassification);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const isCategory = kind === 'category';

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setError('');
    setSaving(false);
    setCategoryId(defaultCategoryId ? String(defaultCategoryId) : '');
  }, [open, kind, defaultCategoryId]);

  useEffect(() => {
    if (!open || isCategory || categoryId || catalog.length === 0) return;
    setCategoryId(String(catalog[0].id));
  }, [open, isCategory, categoryId, catalog]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      const msg = isCategory ? 'Enter a category name.' : 'Enter a classification name.';
      setError(msg);
      await acknowledgeAction({ title: 'Cannot save', message: msg, variant: 'warning' });
      return;
    }
    if (!isCategory && !categoryId) {
      const msg = 'Add a waste category first, then add a classification under it.';
      setError(msg);
      await acknowledgeAction({ title: 'Cannot save', message: msg, variant: 'warning' });
      return;
    }
    setSaving(true);
    setError('');
    const outcome = await confirmThenRun({
      title: isCategory ? 'Save this category?' : 'Save this classification?',
      message: isCategory
        ? `"${trimmed}" will be added to the waste catalog.`
        : `"${trimmed}" will be added under the selected category.`,
      confirmLabel: 'Save',
      busyTitle: 'Saving',
      busyMessage: isCategory ? 'Adding this waste category.' : 'Adding this waste classification.',
      busyLabel: 'Saving…',
      successTitle: isCategory ? 'Category saved' : 'Classification saved',
      successMessage: isCategory ? 'Waste category saved.' : 'Waste classification saved.',
      errorTitle: 'Could not save',
      errorFallback: 'Could not save. Try a different name.',
      work: async () => {
        if (isCategory) {
          await addWasteCategory({ name: trimmed, description: description.trim() || null });
        } else {
          await addWasteClassification({ category_id: Number(categoryId), name: trimmed });
        }
      },
    });
    setSaving(false);
    if (outcome.ok) {
      onCreated?.({ kind, name: trimmed });
      onClose?.();
      return;
    }
    if (outcome.error) setError(apiError(outcome.error, 'Could not save. Try a different name.'));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="add-waste-title"
      size="sm"
      stacked={stacked}
    >
      <div className="modal-head">
        <h3 id="add-waste-title">
          Add <span>{isCategory ? 'waste category' : 'waste classification'}</span>
        </h3>
        <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="modal-body add-waste-body">
        {!isCategory && (
          <div className="field">
            <label htmlFor="add-waste-cat">Category</label>
            <select
              id="add-waste-cat"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={catalog.length === 0}
            >
              {catalog.length === 0 && <option value="">No categories yet</option>}
              {catalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="add-waste-name">{isCategory ? 'Category name' : 'Classification name'}</label>
          <input
            id="add-waste-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isCategory ? 'e.g. Rubber' : 'e.g. Tire fragment'}
            autoFocus
          />
        </div>
        {isCategory && (
          <div className="field">
            <label htmlFor="add-waste-desc">Description (optional)</label>
            <textarea
              id="add-waste-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short note for this category"
            />
          </div>
        )}
        {error ? <AppNotice type="error" title="Could not save" message={error} /> : null}
      </div>
      <div className="modal-foot">
        <button className="btn-ghost" type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-save" type="button" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
