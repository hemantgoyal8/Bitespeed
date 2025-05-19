// src/db.ts (MODIFIED FOR RENDER DEPLOYMENT)
console.log("RAW DATABASE_URL from env:", process.env.DATABASE_URL);
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgres://bitespeed_user:mysecretpassword@localhost:5432/bitespeed_identity_db';


console.log(`Attempting to connect to DB with connection string: ${connectionString.replace(/:[^:]+@/, ':<password_hidden>@')}`); // Log safely

const poolConfig: { connectionString: string; ssl?: { rejectUnauthorized: boolean } } = {
  connectionString: connectionString,
};

if (process.env.NODE_ENV === 'production' && process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')) {
    console.log("Production environment detected, SSL might be used by pg Pool based on DATABASE_URL.");
    
}

const pool = new Pool(poolConfig);

pool.query('SELECT NOW()')
  .then(res => console.log('DB Pool connected successfully to specified DB. DB Time:', res.rows[0].now))
  .catch(err => console.error('DB Pool connection error on initial check with specified DB:', err.stack));

export default pool;
