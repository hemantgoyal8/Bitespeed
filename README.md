# Bitespeed Backend Task: Identity Reconciliation

This project implements a backend service for identity reconciliation as per the Bitespeed backend task. The service exposes an `/identify` endpoint that processes contact information (email and/or phone number) to consolidate customer identities, linking multiple contact records to a single primary identity.

## Project Setup and Local Development

### Prerequisites

*   Node.js (v16 or later recommended)
*   npm (comes with Node.js)
*   Docker (for running PostgreSQL database locally)
*   Git

### Setup Steps

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/hemantgoyal8/Bitespeed.git
    cd Bitespeed # Or your repository's folder name, likely bitespeed-backend
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up the PostgreSQL database using Docker:**
    *   Ensure Docker Desktop is running.
    *   Run the following command in your terminal to start a PostgreSQL container:
        ```bash
        docker run --name bitespeed-db -e POSTGRES_USER=bitespeed_user -e POSTGRES_PASSWORD=mysecretpassword -e POSTGRES_DB=bitespeed_identity_db -p 5432:5432 -d postgres
        ```
        *(Note: You can customize `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` if you wish, but you'll then need to update the database connection string in `src/db.ts` for local development or use environment variables.)*

4.  **Create the `Contact` table schema:**
    *   Connect to the running Dockerized PostgreSQL instance:
        ```bash
        docker exec -it bitespeed-db psql -U bitespeed_user -d bitespeed_identity_db
        ```
        (Enter `mysecretpassword` when prompted if you used the command above).
    *   Execute the contents of `code.sql`  to create the `Contact` table:
    *   Type `\q` to exit `psql`.

5.  **Database Connection (`src/db.ts`):**
    *   The `src/db.ts` file is configured to connect to the PostgreSQL database created by the Docker command in Step 3. It uses the following credentials by default:
        *   User: `bitespeed_user`
        *   Password: `mysecretpassword`
        *   Database: `bitespeed_identity_db`
        *   Host: `localhost`
        *   Port: `5432`
    *   If you customized the `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_DB` environment variables when running the Docker command in Step 3, you must update the corresponding values in the `Pool` configuration within your local `src/db.ts` file to match.
    *   For **production deployment** (e.g., on Render.com), the application will expect a `DATABASE_URL` environment variable. The `src/db.ts` file should be updated for deployment to prioritize `process.env.DATABASE_URL` if present. *(You'll handle this specific modification when preparing for Render deployment).*

    Your local `src/db.ts` should look like this for the default local setup:
    ```typescript
    // src/db.ts
    import { Pool } from 'pg';

    const pool = new Pool({
      user: 'bitespeed_user',
      host: 'localhost',
      database: 'bitespeed_identity_db',
      password: 'mysecretpassword',
      port: 5432,
    });

    export default pool;
    ```
    *(The `testConnection()` function can be kept for local debugging or removed if desired, as the application will attempt to connect when it handles requests.)*
6.  **Run the application in development mode:**
    ```bash
    npm run dev
    ```
    The server will start on `http://localhost:3000`.

## API Endpoint

### Identify Contact

*   **URL:** `/identify`
*   **Method:** `POST`
*   **Headers:** `Content-Type: application/json`
*   **Request Body:**
    ```json
    {
      "email"?: "string | null",
      "phoneNumber"?: "string | null"
    }
    ```
    *At least one of phone number or email must have a non-empty value.*

*   **Success Response (200 OK):**
    ```json
    {
      "contact": {
        "primaryContatctId": number,
        "emails": string[], // First element is the email of the primary contact
        "phoneNumbers": string[], // First element is the phone number of the primary contact
        "secondaryContactIds": number[] // Array of IDs of all secondary contacts linked to this primary
      }
    }
    ```

*   **Error Responses:**
    *   `400 Bad Request`: If the request body is invalid (e.g., missing both identifiers, or both are empty/null).
    *   `500 Internal Server Error`: If an unexpected error occurs on the server.

      Deployed Endpoint

The service is deployed on Render.com and can be accessed at:

Endpoint URL: [YOUR_RENDER_APP_URL_HERE]/identify

(Replace [YOUR_RENDER_APP_URL_HERE] with the actual URL provided by Render after deployment, e.g., https://bitespeed-identity-api.onrender.com)

Technology Stack
Node.js
Express.js
TypeScript
PostgreSQL
pg (Node.js PostgreSQL client)

Code Structure
src/index.ts: Main application file containing the Express server setup, route handler for /identify, and all identity reconciliation logic.
src/db.ts: PostgreSQL database connection pool setup.
package.json: Project dependencies and scripts.
tsconfig.json: TypeScript compiler configuration.
.gitignore: Specifies intentionally untracked files that Git should ignore.
code.sql: Contains the SQL CREATE TABLE statement for the Contact table.

### Example Request

```json
{
  "email": "lorraine@hillvalley.edu",
  "phoneNumber": "123456"
}

Example Response (for a new contact)
{
  "contact": {
    "primaryContatctId": 1,
    "emails": ["lorraine@hillvalley.edu"],
    "phoneNumbers": ["123456"],
    "secondaryContactIds": []
  }
}

Example Response (after linking another contact)

Request:

{
  "email": "mcfly@hillvalley.edu",
  "phoneNumber": "123456"
}

Response (assuming Lorraine was primary ID 1):

{
  "contact": {
    "primaryContatctId": 1,
    "emails": ["lorraine@hillvalley.edu", "mcfly@hillvalley.edu"],
    "phoneNumbers": ["123456"],
    "secondaryContactIds": [2] // Assuming mcfly's record got ID 2
  }
}


