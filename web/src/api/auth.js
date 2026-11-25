import client from './client';

/** POST /login → { token, user } */
/** The signed-in account (name, username, role). */
export async function currentUser() {
  const { data } = await client.get('/user', { timeout: 15000 });
  return data;
}

/** Upload a profile photo (already cropped to a square in the browser). */
export async function uploadAvatar(blob) {
  const form = new FormData();
  form.append('photo', blob, 'avatar.jpg');
  const { data } = await client.post('/user/avatar', form, { timeout: 30000 });
  return data;
}

/** Remove the profile photo; the initials show again. */
export async function removeAvatar() {
  const { data } = await client.delete('/user/avatar', { timeout: 15000 });
  return data;
}

/** Sign in with the username (or email). */
export async function login(username, password) {
  const { data } = await client.post('/login', { username, password }, { timeout: 15000 });
  return data;
}
