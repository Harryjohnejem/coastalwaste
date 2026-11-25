import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '../common/Modal';
import { useAuthStore } from '../../stores/useAuthStore';
import { actionErrorMessage, confirmAction, notice } from '../../stores/useNoticeStore';
import { removeAvatar, uploadAvatar } from '../../api/auth';
import PhotoCropper from './PhotoCropper';

const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

function initials(name) {
  const parts = String(name || 'U').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

/** Open a picked file as an image the cropper can draw. */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ image: img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This file is not a picture the browser can open.'));
    };
    img.src = url;
  });
}

function Avatar({ user, className = 'tr-avatar' }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [user?.avatar_url]);
  if (user?.avatar_url && !broken) {
    return (
      <span className={`${className} has-photo`}>
        <img src={user.avatar_url} alt="" onError={() => setBroken(true)} />
      </span>
    );
  }
  return <span className={className}>{initials(user?.name)}</span>;
}

/** Avatar on the Main Dashboard: who is signed in, profile photo, and Log out. */
export default function AccountMenu() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const setAuth = useAuthStore((s) => s.setAuth);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null); // { image, url }
  const cropRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Free the preview image when the window closes.
  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview]);

  const signOut = async () => {
    setOpen(false);
    const accepted = await confirmAction({
      title: 'Log out?',
      message: 'You will need to sign in again to use the monitoring station.',
      confirmLabel: 'Log out',
      variant: 'warning',
    });
    if (!accepted) return;
    logout();
    navigate('/login', { replace: true });
  };

  const choosePhoto = () => {
    setOpen(false);
    fileRef.current?.click();
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      notice.error('Photo not changed', 'Choose a JPG, PNG, or WebP picture.');
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      notice.error('Photo not changed', 'That picture is larger than 15 MB. Choose a smaller one.');
      return;
    }
    try {
      setPreview(await loadImage(file));
    } catch (err) {
      notice.error('Photo not changed', err.message);
    }
  };

  const savePhoto = async () => {
    if (!preview || saving) return;
    setSaving(true);
    try {
      const blob = await cropRef.current.getBlob();
      const next = await uploadAvatar(blob);
      setAuth(token, next);
      setPreview(null);
      notice.success('Photo updated', 'Your new profile photo is saved.');
    } catch (err) {
      notice.error('Photo not saved', actionErrorMessage(err, 'Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const deletePhoto = async () => {
    setOpen(false);
    const accepted = await confirmAction({
      title: 'Remove photo?',
      message: 'Your initials will show again instead of the photo.',
      confirmLabel: 'Remove',
      variant: 'warning',
    });
    if (!accepted) return;
    try {
      setAuth(token, await removeAvatar());
      notice.success('Photo removed', 'Your initials show again.');
    } catch (err) {
      notice.error('Photo not removed', actionErrorMessage(err, 'Please try again.'));
    }
  };

  const name = user?.name || 'User';
  const role = String(user?.role || '').toLowerCase() === 'admin' ? 'Administrator' : user?.role || '';

  return (
    <div className="tr-account" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="tr-avatar-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        title={name}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar user={user} />
      </button>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={onFile} />

      {open ? (
        <div className="tr-account-menu" role="menu" aria-label="Account">
          <div className="tr-account-head">
            {/* Click the picture to add or change the profile photo. */}
            <button
              type="button"
              role="menuitem"
              className="tr-account-photo"
              aria-label={user?.avatar_url ? 'Change photo' : 'Add photo'}
              title={user?.avatar_url ? 'Change photo' : 'Add photo'}
              onClick={choosePhoto}
            >
              <Avatar user={user} />
              <span className="tr-account-photo-badge" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
                  <circle cx="12" cy="13" r="3.5" />
                </svg>
              </span>
            </button>
            <div>
              <strong>{name}</strong>
              <span>
                {user?.username ? `@${user.username}` : user?.email || ''}
                {role ? ` · ${role}` : ''}
              </span>
            </div>
          </div>
          {user?.avatar_url ? (
            <button type="button" role="menuitem" className="tr-account-item" onClick={deletePhoto}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
              </svg>
              Remove photo
            </button>
          ) : null}
          <div className="tr-account-sep" />
          <button type="button" role="menuitem" className="tr-account-item is-danger" onClick={signOut}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
              <path d="M10 17l-5-5 5-5M5 12h11" />
            </svg>
            Log out
          </button>
        </div>
      ) : null}

      <Modal open={Boolean(preview)} onClose={() => !saving && setPreview(null)} labelledBy="avatar-preview-title" size="sm">
        <div className="modal-head">
          <h3 id="avatar-preview-title">New profile photo</h3>
          <button className="modal-close" type="button" aria-label="Close" disabled={saving} onClick={() => setPreview(null)}>
            ×
          </button>
        </div>
        <div className="modal-body avatar-preview-body">
          {preview ? <PhotoCropper image={preview.image} apiRef={cropRef} /> : null}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" type="button" disabled={saving} onClick={choosePhoto}>
            Choose another
          </button>
          <button className="btn-save" type="button" disabled={saving} onClick={savePhoto}>
            {saving ? 'Saving…' : 'Save photo'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
