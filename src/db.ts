// src/db.ts
import { Pool } from 'pg'; // For PostgreSQL

// Configuration for your database connection
// It's better to use environment variables for these in a real app
const pool = new Pool({
  user: 'postgres', // or your DB user
  host: 'localhost',
  database: 'postgres', // or your DB name if you created a specific one
  password: 'mysecretpassword', // the password you set
  port: 5432,
});

// Test the connection
async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('Successfully connected to the database!');
    const res = await client.query('SELECT NOW()');
    console.log('Current time from DB:', res.rows[0].now);
    client.release(); // Release the client back to the pool
  } catch (err) {
    console.error('Error connecting to the database', err);
  } finally {
    // Optionally, end the pool if this is just a one-off test script
    // await pool.end();
  }
}

// Call it to see if it works
testConnection();

// Export the pool for other parts of your application to use
export default pool;