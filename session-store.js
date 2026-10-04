/**
 * WhatsApp Session Store — keeps the WhatsApp login in Supabase Storage
 * so it survives server restarts on hosts without a persistent disk (e.g. Render free).
 * Implements the store interface used by whatsapp-web.js RemoteAuth.
 */
const fs = require('fs');
const path = require('path');

const BUCKET = 'whatsapp-session';

class SupabaseSessionStore {
  constructor(supabase, dataPath) {
    this.supabase = supabase;
    this.dataPath = dataPath;
    this.bucketReady = null;
  }

  ensureBucket() {
    if (!this.bucketReady) {
      this.bucketReady = this.supabase.storage.createBucket(BUCKET, { public: false })
        .then(({ error }) => {
          if (error && !/already exists/i.test(error.message)) throw error;
        })
        .catch(err => {
          this.bucketReady = null;
          throw err;
        });
    }
    return this.bucketReady;
  }

  async sessionExists({ session }) {
    await this.ensureBucket();
    const { data, error } = await this.supabase.storage.from(BUCKET).list('', { search: `${session}.zip` });
    if (error) throw error;
    return data.some(file => file.name === `${session}.zip`);
  }

  async save({ session }) {
    await this.ensureBucket();
    // RemoteAuth writes the zip into its dataPath (older versions used the working directory)
    const candidates = [path.join(this.dataPath, `${session}.zip`), path.resolve(`${session}.zip`)];
    const zipPath = candidates.find(p => fs.existsSync(p));
    if (!zipPath) throw new Error(`Session archive ${session}.zip not found`);

    const { error } = await this.supabase.storage.from(BUCKET)
      .upload(`${session}.zip`, fs.readFileSync(zipPath), { upsert: true, contentType: 'application/zip' });
    if (error) throw error;
  }

  async extract({ session, path: destination }) {
    const { data, error } = await this.supabase.storage.from(BUCKET).download(`${session}.zip`);
    if (error) throw error;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(await data.arrayBuffer()));
  }

  async delete({ session }) {
    const { error } = await this.supabase.storage.from(BUCKET).remove([`${session}.zip`]);
    if (error) throw error;
  }
}

module.exports = { SupabaseSessionStore };
