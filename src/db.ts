import { Pool } from 'pg'; 
const pool = new Pool({
  user: 'bitespeed_user', 
  host: 'localhost',
  database: 'bitespeed_identity_db', 
  password: 'mysecretpassword', 
  port: 5432,
});


async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('Successfully connected to the database!');
    const res = await client.query('SELECT NOW()');
    console.log('Current time from DB:', res.rows[0].now);
    client.release(); // Release the client back to the pool
  } catch (err) {
    console.error('Error connecting to the database', err);
  } 
}

testConnection();

export default pool;
