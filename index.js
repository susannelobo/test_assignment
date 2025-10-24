const express = require('express');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

// --- pg (Node-Postgres) setup ---
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to the database:', err);
  } else {
    console.log('Database connected successfully:', res.rows[0].now);
  }
});

// --- HELPER FUNCTION: setNestedProperty ---
function setNestedProperty(obj, path, value) {
  if (value === '') {
    return;
  }
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key]) {
      current[key] = {};
    }
    current = current[key];
  }
  const lastKey = keys[keys.length - 1];
  if (path === 'age' && value) {
    current[lastKey] = parseInt(value, 10);
  } else {
    current[lastKey] = value;
  }
}

// --- HELPER: transformForDb ---
function transformForDb(obj) {
  const { name, age, address, ...additional_info } = obj;
  const dbRow = {
    name: `${name?.firstName || ''} ${name?.lastName || ''}`.trim(),
    age: age || 0,
    address: address || null,
    additional_info: additional_info || null,
  };
  return dbRow;
}

// --- HELPER: insertDataBatch ---
async function insertDataBatch(batch) {
  if (batch.length === 0) return;

  const client = await pool.connect();
  try {
    const values = [];
    const queryParams = batch
      .map((row, rowIndex) => {
        const i = rowIndex * 4;
        values.push(row.name, row.age, row.address, row.additional_info);
        return `($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4})`;
      })
      .join(',');

    const queryText = `
      INSERT INTO public.users (name, age, address, additional_info) 
      VALUES ${queryParams}
    `;
    await client.query(queryText, values);
    console.log(`Successfully inserted batch of ${batch.length} records.`);
  } catch (err) {
    console.error('Error inserting batch:', err);
  } finally {
    client.release();
  }
}

// --- NEW FUNCTION: Age Distribution Report ---
/**
 * Queries the database and prints the age distribution report.
 */
async function calculateAndPrintAgeDistribution() {
  console.log('\nCalculating Age Distribution...');

  const queryText = `
    WITH age_groups AS (
      SELECT
        CASE
          WHEN age < 20 THEN '< 20'
          WHEN age >= 20 AND age <= 40 THEN '20 to 40'
          WHEN age > 40 AND age <= 60 THEN '40 to 60'
          WHEN age > 60 THEN '> 60'
        END AS "Age-Group"
      FROM public.users
    ),
    total_users AS (
      SELECT COUNT(*) AS total FROM public.users
    )
    SELECT
      g."Age-Group",
      -- Calculate percentage, round to 2 decimal places
      ROUND((COUNT(g."Age-Group")::decimal / t.total::decimal) * 100.0, 2) AS "% Distribution"
    FROM age_groups g, total_users t
    WHERE g."Age-Group" IS NOT NULL
    GROUP BY g."Age-Group", t.total
    ORDER BY 
      CASE g."Age-Group"
        WHEN '< 20' THEN 1
        WHEN '20 to 40' THEN 2
        WHEN '40 to 60' THEN 3
        WHEN '> 60' THEN 4
      END;
  `;

  try {
    const res = await pool.query(queryText);
    
    // Format for console.table
    const report = res.rows.map(row => ({
      'Age-Group': row['Age-Group'],
      '% Distribution': row['% Distribution']
    }));

    console.log('\n--- Age Distribution Report ---');
    console.table(report);
    console.log('---------------------------------');

  } catch (err) {
    console.error('Error calculating age distribution:', err);
  }
}
// ------------------------------------------

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello! Your Express server is running. 🚀');
});

// --- UPDATED app.post BLOCK ---
app.post('/upload', async (req, res) => {
  console.log('Upload request received. Starting CSV processing...');

  const csvFilePath = path.resolve(__dirname, process.env.CSV_FILE_PATH);
  
  let headers = [];
  let isFirstLine = true;
  let batch = [];
  const BATCH_SIZE = 1000;

  if (!fs.existsSync(csvFilePath)) {
    console.error('File does not exist at path:', csvFilePath);
    return res.status(500).send({ message: 'Error: File not found.' });
  }
  
  const fileStream = fs.createReadStream(csvFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity 
  });

  // Using a try-catch-finally to ensure we always respond
  try {
    for await (const line of rl) {
      if (isFirstLine) {
        headers = line.split(',');
        isFirstLine = false;
      } else {
        const values = line.split(',');
        let rowObject = {}; 
        headers.forEach((header, index) => {
          const value = values[index];
          setNestedProperty(rowObject, header, value);
        });
        
        const dbRow = transformForDb(rowObject);
        batch.push(dbRow);
        
        if (batch.length >= BATCH_SIZE) {
          await insertDataBatch(batch);
          batch = [];
        }
      }
    }

    if (batch.length > 0) {
      await insertDataBatch(batch);
    }

    console.log('All data has been successfully uploaded to the database.');
    res.status(200).send({ message: 'File processing complete. Data inserted.' });

    // --- RUN THE REPORT ---
    // We run this *after* sending the response so the user isn't waiting
    calculateAndPrintAgeDistribution();
    // ----------------------

  } catch (err) {
    console.error('An error occurred during the upload process:', err);
    if (!res.headersSent) {
      res.status(500).send({ message: 'An error occurred during the upload.' });
    }
  }
});
// ------------------------------

app.listen(PORT, () => {
  console.log(`Server is listening on http://localhost:${PORT}`);
});