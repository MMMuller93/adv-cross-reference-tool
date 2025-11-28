# Form D & Form ADV Cross-Reference Tool

A powerful visualization and analysis tool for SEC Form D filings and RIA Form ADV data.

## Features

- **Live Search**: Search Form D filings with pagination support
- **New Managers Discovery**: Track new fund managers entering the market
- **Adviser & Fund Details**: Detailed visualizer with historical charts
- **Cross-Reference Detection**: Identify discrepancies between Form D and ADV filings
- **Advanced Filtering**: Date range, state, and fund type filters
- **Export Functionality**: Export data to CSV or Markdown with full details

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: Supabase PostgreSQL
- **Frontend**: React (vanilla, CDN-based)
- **Charts**: Chart.js
- **Styling**: Tailwind CSS

## Local Development

```bash
npm install
npm start
```

Navigate to `http://localhost:3009`

## Deployment

This app is configured for Railway deployment:
1. Connect GitHub repository
2. Railway auto-detects Node.js and uses `npm start`
3. Set PORT environment variable (handled automatically)

## Data Sources

- SEC Form ADV filings (Supabase)
- SEC Form D filings (Supabase)

## License

MIT
