import { useEffect, useState } from 'react';
import FilterSelect from '../common/FilterSelect';
import AddWasteModal from './AddWasteModal';
import { listsFromCatalog, locationOf } from '../../lib/wasteFilters';
import { datasetAttributionFilterOptions } from '../../lib/datasetSource';
import { useSettingsStore } from '../../stores/useSettingsStore';

const DATE_OPTIONS = [
  'All Dates',
  'Today',
  'Yesterday',
  'Last 7 Days',
  'Last 30 Days',
  'This Month',
  'Last Month',
  'Custom Range',
];

export default function FilterBar({
  filters,
  onChange,
  cameras = [],
  detections = [],
}) {
  const catalog = useSettingsStore((s) => s.wasteCatalog);
  const { categories, subtypes } = listsFromCatalog(catalog);
  const [addKind, setAddKind] = useState(null);
  const [searchInput, setSearchInput] = useState(filters.search || '');

  useEffect(() => {
    setSearchInput(filters.search || '');
  }, [filters.search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.search || '') === searchInput) return;
      onChange({ ...filters, search: searchInput });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, filters, onChange]);

  const set = (key, value) => {
    if (key === 'wasteType') {
      onChange({
        ...filters,
        wasteType: value,
        wasteSubtype: 'All Classifications',
      });
      return;
    }
    onChange({ ...filters, [key]: value });
  };

  const locationSet = new Set();
  cameras.forEach((c) => {
    const loc = locationOf({ location: c.location, sector: c.sector });
    if (loc && loc !== '—') locationSet.add(loc);
  });
  detections.forEach((d) => {
    const loc = locationOf(d);
    if (loc && loc !== '—') locationSet.add(loc);
  });
  if (locationSet.size === 0) {
    locationSet.add('Paco Beach');
    locationSet.add('B-MEG Zone 4');
  }

  const cameraOpts = [
    { value: 'All Cameras', label: 'All Cameras' },
    ...cameras.map((c) => ({
      value: c.id,
      label: c.name ? `${c.id} · ${c.name.replace(`${c.id} · `, '')}` : c.id,
    })),
  ];

  const categoryOpts = [
    { value: 'All Categories', label: 'All Categories' },
    ...categories.map((o) => ({ value: o, label: o })),
    { value: '__add_category__', label: '+ Add waste category', kind: 'action', group: 'Manage' },
  ];

  const classificationOpts = [{ value: 'All Classifications', label: 'All Classifications' }];
  const categoryFilter =
    filters.wasteType && categories.includes(filters.wasteType) ? filters.wasteType : null;
  if (categoryFilter) {
    (subtypes[categoryFilter] || []).forEach((o) => {
      classificationOpts.push({ value: o, label: o });
    });
  } else {
    categories.forEach((cat) => {
      (subtypes[cat] || []).forEach((o) => {
        classificationOpts.push({ value: o, label: o, group: cat });
      });
    });
  }
  classificationOpts.push({
    value: '__add_classification__',
    label: '+ Add waste classification',
    kind: 'action',
    group: 'Manage',
  });

  const locationOpts = [
    { value: 'All Locations', label: 'All Locations' },
    ...[...locationSet].sort().map((o) => ({ value: o, label: o })),
  ];

  const datasetSourceOpts = datasetAttributionFilterOptions(detections);

  const selectedCatalogCategory = categoryFilter
    ? catalog.find((c) => c.name === categoryFilter)
    : null;

  return (
    <div className="filter-bar">
      <FilterSelect
        id="flt-date"
        label="Date Range"
        value={filters.dateRange}
        options={DATE_OPTIONS.map((o) => ({ value: o, label: o }))}
        onChange={(v) => set('dateRange', v)}
      />

      {filters.dateRange === 'Custom Range' && (
        <>
          <div className="filter-field">
            <label htmlFor="flt-from">From</label>
            <input
              id="flt-from"
              type="date"
              value={filters.from || ''}
              onChange={(e) => set('from', e.target.value)}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="flt-to">To</label>
            <input
              id="flt-to"
              type="date"
              value={filters.to || ''}
              onChange={(e) => set('to', e.target.value)}
            />
          </div>
        </>
      )}

      <FilterSelect
        id="flt-type"
        label="Waste Category"
        value={
          filters.wasteType === 'All Types' ? 'All Categories' : filters.wasteType
        }
        options={categoryOpts}
        onChange={(v) => {
          if (v === '__add_category__') {
            setAddKind('category');
            return;
          }
          set('wasteType', v);
        }}
      />

      <FilterSelect
        id="flt-subtype"
        label="Waste Classification"
        value={filters.wasteSubtype || 'All Classifications'}
        options={classificationOpts}
        onChange={(v) => {
          if (v === '__add_classification__') {
            setAddKind('classification');
            return;
          }
          set('wasteSubtype', v);
        }}
      />

      <FilterSelect
        id="flt-loc"
        label="Location"
        value={filters.location}
        options={locationOpts}
        onChange={(v) => set('location', v)}
      />

      <FilterSelect
        id="flt-cam"
        label="Camera / Detection Source"
        value={filters.camera}
        options={cameraOpts}
        onChange={(v) => set('camera', v)}
      />

      {datasetSourceOpts.length > 1 ? (
        <div
          title="Training-dataset attribution (not the camera). Local 1/Local 2 only appear when verified lineage exists — live YOLO predictions use Combined Model — Source Not Attributable."
        >
          <FilterSelect
            id="flt-dataset"
            label="Dataset Source"
            value={filters.datasetSource || 'All Sources'}
            options={datasetSourceOpts}
            onChange={(v) => set('datasetSource', v)}
          />
        </div>
      ) : null}

      <div className="filter-field filter-search">
        <label htmlFor="flt-search">Search</label>
        <input
          id="flt-search"
          type="search"
          placeholder="Category, camera, dataset source…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>

      <AddWasteModal
        open={Boolean(addKind)}
        kind={addKind || 'category'}
        defaultCategoryId={selectedCatalogCategory?.id}
        onClose={() => setAddKind(null)}
      />
    </div>
  );
}
