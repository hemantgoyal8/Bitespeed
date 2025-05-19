// src/index.ts
import express, { Request, Response, NextFunction } from 'express';
import pool from './db'; 

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

interface ContactRow {
  id: number;
  phonenumber: string | null;
  email: string | null;
  linkedid: number | null;
  linkprecedence: 'primary' | 'secondary';
  createdat: Date;
  updatedat: Date;
  deletedat: Date | null;
}

app.post('/identify', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  console.log('Received /identify request with body:', req.body);

  const { email, phoneNumber: requestPhoneNumber } = req.body as { email?: string | null; phoneNumber?: string | null };

  if (requestPhoneNumber === undefined && email === undefined) {
    res.status(400).json({
    error: "Either email or phoneNumber (or both) must be present in the request body.",
    });
    return;
}
const isEmailProvided = typeof email === 'string' && email.trim() !== '';
const isPhoneNumberProvided = typeof requestPhoneNumber === 'string' && requestPhoneNumber.trim() !== '';

if (!isEmailProvided && !isPhoneNumberProvided) {
    res.status(400).json({
    error: "At least one of email or phoneNumber must have a non-empty value.",
    });
    return;
}

const queryEmail = isEmailProvided ? email : null;
const queryPhoneNumber = isPhoneNumberProvided ? requestPhoneNumber : null;

  const client = await pool.connect(); 

  try {
    const findContactsQuery = `
      SELECT id, phonenumber, email, linkedid, linkprecedence, createdat, updatedat, deletedat
      FROM Contact
      WHERE deletedat IS NULL AND
            ((email = $1 AND $1 IS NOT NULL) OR (phonenumber = $2 AND $2 IS NOT NULL))
      ORDER BY createdat ASC;
    `;
    const { rows: matchingContacts } = await client.query<ContactRow>(findContactsQuery, [queryEmail, queryPhoneNumber]);

    if (matchingContacts.length === 0) {
      const insertContactQuery = `
        INSERT INTO Contact (email, phonenumber, linkprecedence)
        VALUES ($1, $2, 'primary')
        RETURNING id, email, phonenumber;
      `;
      const { rows: newContactRows } = await client.query(insertContactQuery, [queryEmail, queryPhoneNumber]);
      const newContact = newContactRows[0];

      res.status(200).json({
        contact: {
          primaryContatctId: newContact.id,
          emails: newContact.email ? [newContact.email] : [],
          phoneNumbers: newContact.phonenumber ? [newContact.phonenumber] : [],
          secondaryContactIds: [],
        },
      });

    } else {
      console.log("Original matching contacts based on input:", matchingContacts.map(c => ({id: c.id, email: c.email, phone: c.phonenumber, precedence: c.linkprecedence, linkedId: c.linkedid })));

      const implicatedPrimaryIds = new Set<number>();
      for (const contact of matchingContacts) {
        if (contact.linkprecedence === 'primary') {
          implicatedPrimaryIds.add(contact.id);
        } else if (contact.linkedid !== null) {
          implicatedPrimaryIds.add(contact.linkedid);
        }
      }

      if (implicatedPrimaryIds.size === 0 && matchingContacts.length > 0) {
        console.error("Could not determine any implicated primary IDs from matches:", matchingContacts);
        throw new Error("Data inconsistency: Could not trace matches to a primary contact.");
      }
      
      let ultimatePrimaryContact: ContactRow | undefined;

      if (implicatedPrimaryIds.size <= 1) {
        // Handles cases where matches point to one primary group
  
        const primaryDirectMatches = matchingContacts.filter(c => c.linkprecedence === 'primary');
        if (primaryDirectMatches.length > 0) {
            // If direct matches include primaries, pick the oldest 
            ultimatePrimaryContact = primaryDirectMatches[0];
        } else if (matchingContacts.length > 0 && matchingContacts[0].linkedid !== null) {
            // Alll direct matchs are secondary, fetch their common primary
            const primaryId = matchingContacts[0].linkedid;
            const primaryResult = await client.query<ContactRow>("SELECT * FROM Contact WHERE id = $1 AND deletedat IS NULL", [primaryId]);
            if (primaryResult.rows.length > 0) {
                ultimatePrimaryContact = primaryResult.rows[0];
            } else {
                throw new Error(`Data inconsistency: Primary contact for ID ${primaryId} not found or deleted.`);
            }
        } else if (matchingContacts.length > 0) {
             throw new Error("Could not determine primary contact from the initial matches due to data inconsistency.");
        }
      } else {
        // Multiple distinct primary identities are implicated. MERGE IS NEEDED.
        console.log("Multiple primary identities implicated. IDs:", Array.from(implicatedPrimaryIds), ". Merge required.");
        
        await client.query('BEGIN');

        try {
            const primaryCandidatesQuery = `SELECT * FROM Contact WHERE id = ANY($1::int[]) AND deletedat IS NULL ORDER BY createdat ASC;`;
            // We fetch all candidates (primary or secondary that became primary) to ensure we get the true oldest and then check their linkprecedence again if needed
            const { rows: potentialPrimariesAllTypes } = await client.query<ContactRow>(primaryCandidatesQuery, [Array.from(implicatedPrimaryIds)]);

            // Filter again to be absolutely sure we are only considering current primaries for demotion
            const potentialCurrentPrimaries = potentialPrimariesAllTypes.filter(c => c.linkprecedence ==='primary');

            if (potentialCurrentPrimaries.length === 0) {
                // This could happen if all implicated IDs were secondaries that pointed to different primaries,
                if(potentialPrimariesAllTypes.length === 0){
                    throw new Error("Could not find any primary candidates for merging.");
                }
                ultimatePrimaryContact = potentialPrimariesAllTypes[0]; // The oldest one overall
                console.log("Ultimate Primary selected (oldest overall contact):", {id: ultimatePrimaryContact.id, email: ultimatePrimaryContact.email, createdat: ultimatePrimaryContact.createdat});

                // Now, ensure this ultimatePrimaryContact is 'primary' and has no linkedid
                if(ultimatePrimaryContact.linkprecedence !== 'primary' || ultimatePrimaryContact.linkedid !== null) {
                    await client.query(
                        "UPDATE Contact SET linkprecedence = 'primary', linkedid = NULL, updatedat = NOW() WHERE id = $1",
                        [ultimatePrimaryContact.id]
                    );
                    ultimatePrimaryContact.linkprecedence = 'primary';
                    ultimatePrimaryContact.linkedid = null;
                }

                // Demote others in potentialPrimariesAllTypes if they are not the ultimatePrimaryContact
                for (const contact of potentialPrimariesAllTypes) {
                    if (contact.id !== ultimatePrimaryContact.id) {
                        console.log(`Updating contact ID ${contact.id} to be secondary of ${ultimatePrimaryContact.id}`);
                        await client.query(
                            "UPDATE Contact SET linkprecedence = 'secondary', linkedid = $1, updatedat = NOW() WHERE id = $2",
                            [ultimatePrimaryContact.id, contact.id]
                        );
                        // Also update any contacts that were secondary to this `contact` (if it was a primary)
                        await client.query(
                            "UPDATE Contact SET linkedid = $1, updatedat = NOW() WHERE linkedid = $2 AND id != $1", // Avoid self-linking
                            [ultimatePrimaryContact.id, contact.id]
                        );
                    }
                }

            } else {
                ultimatePrimaryContact = potentialCurrentPrimaries[0]; // The oldest current primary
                console.log("Ultimate Primary selected for merge (oldest current primary):", {id: ultimatePrimaryContact.id, email: ultimatePrimaryContact.email, createdat: ultimatePrimaryContact.createdat});

                for (const oldPrimary of potentialCurrentPrimaries) {
                    if (oldPrimary.id !== ultimatePrimaryContact.id) {
                        console.log(`Demoting primary ID ${oldPrimary.id} to secondary of ${ultimatePrimaryContact.id}`);
                        await client.query(
                        "UPDATE Contact SET linkprecedence = 'secondary', linkedid = $1, updatedat = NOW() WHERE id = $2",
                        [ultimatePrimaryContact.id, oldPrimary.id]
                        );
                        await client.query(
                        "UPDATE Contact SET linkedid = $1, updatedat = NOW() WHERE linkedid = $2 AND id != $1",
                        [ultimatePrimaryContact.id, oldPrimary.id]
                        );
                    }
                }
            }
            await client.query('COMMIT'); // COMMIT TRANSACTION
        } catch (e) {
            await client.query('ROLLBACK'); // ROLLBACK TRANSACTION ON ERROR
            throw e; // 
        }
      }
      
      if (!ultimatePrimaryContact) {
        throw new Error("Ultimate primary contact could not be determined after all logic.");
      }
      const groupContactsQuery = `
        SELECT id, phonenumber, email, linkedid, linkprecedence, createdat
        FROM Contact
        WHERE deletedat IS NULL AND (id = $1 OR linkedid = $1)
        ORDER BY linkprecedence ASC, createdat ASC;
      `;
      const { rows: groupContacts } = await client.query<ContactRow>(groupContactsQuery, [ultimatePrimaryContact.id]);
      let allContactsInGroup = groupContacts;
      
      console.log("All contacts in the final group (post-merge if any):", allContactsInGroup.map(c =>({id: c.id, email: c.email, phone: c.phonenumber, precedence: c.linkprecedence, linkedId: c.linkedid })));

      // 3. Check if new information is being added
      const currentRequestEmail = queryEmail;
      const currentRequestPhoneNumber = queryPhoneNumber;

      const exactMatchExists = allContactsInGroup.some(contact =>
        contact.email === currentRequestEmail && contact.phonenumber === currentRequestPhoneNumber
      );

      let createdNewSecondaryInThisRequest = false;
      if (!exactMatchExists && (currentRequestEmail || currentRequestPhoneNumber)) {
          const sharesIdentifierWithGroup = matchingContacts.some(mc => // Check against original matches to see if it links
            (currentRequestEmail && mc.email === currentRequestEmail) ||
            (currentRequestPhoneNumber && mc.phonenumber === currentRequestPhoneNumber)
          );

          if(sharesIdentifierWithGroup) { // It links, now check if it's new info *for the ultimate primary's group*
                console.log("New information identified for this group or new combination. Creating secondary contact linked to ultimate primary.");
                const insertSecondaryQuery = `
                    INSERT INTO Contact (email, phonenumber, linkprecedence, linkedid)
                    VALUES ($1, $2, 'secondary', $3)
                    RETURNING id, phonenumber, email, linkedid, linkprecedence, createdat;
                `;
                // We need a transaction here as well if the merge didn't happen in this specific request flow
                // but we are creating a new secondary. For simplicity now, not wrapping this part,
                // but ideally, any multi-statement write should be transactional.
                const { rows: newSecondaryRows } = await client.query<ContactRow>(insertSecondaryQuery, [
                    currentRequestEmail,
                    currentRequestPhoneNumber,
                    ultimatePrimaryContact.id
                ]);
                if (newSecondaryRows.length > 0) {
                    allContactsInGroup.push(newSecondaryRows[0]); // Add to current group for response
                    createdNewSecondaryInThisRequest = true;
                    console.log("New secondary contact created:", newSecondaryRows[0]);
                }
            }
      }

      // 4. Consolidate information for the response
      const primaryEmailForResponse = ultimatePrimaryContact.email;
      const primaryPhoneNumberForResponse = ultimatePrimaryContact.phonenumber;

      const emailsSet = new Set<string>();
      if (primaryEmailForResponse) emailsSet.add(primaryEmailForResponse);
      allContactsInGroup.forEach(c => { if (c.email) emailsSet.add(c.email); });
      const emailsArray = primaryEmailForResponse ? [primaryEmailForResponse, ...Array.from(emailsSet).filter(e => e !== primaryEmailForResponse)] : Array.from(emailsSet);

      const phoneNumbersSet = new Set<string>();
      if (primaryPhoneNumberForResponse) phoneNumbersSet.add(primaryPhoneNumberForResponse);
      allContactsInGroup.forEach(c => { if (c.phonenumber) phoneNumbersSet.add(c.phonenumber); });
      const phoneNumbersArray = primaryPhoneNumberForResponse ? [primaryPhoneNumberForResponse, ...Array.from(phoneNumbersSet).filter(p => p !== primaryPhoneNumberForResponse)] : Array.from(phoneNumbersSet);
      
      const secondaryContactIds = allContactsInGroup
        .filter(c => c.id !== ultimatePrimaryContact.id) // All other contacts in the group are effectively secondary
        .map(c => c.id)
        .filter((id, index, self) => self.indexOf(id) === index) // Ensure unique IDs
        .sort((a,b) => a-b);

      res.status(200).json({
        contact: {
          primaryContatctId: ultimatePrimaryContact.id,
          emails: emailsArray,
          phoneNumbers: phoneNumbersArray,
          secondaryContactIds: secondaryContactIds,
        }
      });
    }
  } catch (error) {
    console.error("Error processing /identify request (outer catch):", error);
    if (!res.headersSent) {
        res.status(500).json({error: "Internal server error during identity processing."});
    }
    // Not calling next(error) here if we sent a response.
    // If next(error) were to be called, client.release() should happen before it.
  } finally {
    client.release(); // Release the client back to the pool in all cases
  }
});

// Global Error Handling Middleware (remains the same)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("Unhandled error caught by middleware:", err.message, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal Server Error" });
  } else {
    next(err);
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`POST requests to /identify will be handled.`);
});