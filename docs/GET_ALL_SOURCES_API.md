# Get All Sources API

## Overview

The Get All Sources API allows authenticated users to retrieve a complete list of all their stored data in Pinecone, including:
- **Uploaded Documents** (PDF, Word, Excel, CSV, TXT files)
- **Scraped Websites** (URLs with their content)

This endpoint provides a comprehensive view of all the knowledge sources available for the user's RAG chatbot.

---

## API Endpoint

### **GET /api/auth/scraper/sources**

Retrieve all sources (documents and websites) stored for the authenticated user.

**Authentication**: Required (JWT token)

**Request Type**: `GET`

**Headers**:
- `Cookie: access_token=YOUR_ACCESS_TOKEN`

---

## CURL Example

```bash
curl -X GET http://localhost:3000/api/auth/scraper/sources \
  -H "Cookie: access_token=YOUR_ACCESS_TOKEN"
```

---

## Response Format

### Success Response (200 OK)

```json
{
  "success": true,
  "message": "Sources retrieved successfully",
  "data": {
    "documents": [
      {
        "filename": "Webomind VAPT final report.pdf",
        "url": "document://Webomind VAPT final report.pdf",
        "fileType": "pdf",
        "uploadedAt": "2026-01-07T10:30:00.000Z",
        "chunks": 15
      },
      {
        "filename": "Product Manual.docx",
        "url": "document://Product Manual.docx",
        "fileType": "docx",
        "uploadedAt": "2026-01-06T15:20:00.000Z",
        "chunks": 8
      }
    ],
    "websites": [
      {
        "url": "https://www.webomindapps.com/",
        "title": "Webomind Apps - Home",
        "scrapedAt": "2026-01-07T09:15:00.000Z",
        "chunks": 45
      },
      {
        "url": "https://www.webomindapps.com/about",
        "title": "About Us - Webomind Apps",
        "scrapedAt": "2026-01-07T09:15:30.000Z",
        "chunks": 12
      }
    ],
    "summary": {
      "totalDocuments": 2,
      "totalWebsites": 2,
      "totalChunks": 80
    }
  }
}
```

---

## Response Fields

### Documents Array
Each document object contains:

| Field | Type | Description |
|-------|------|-------------|
| `filename` | string | Original filename of the uploaded document |
| `url` | string | Document URL in format `document://filename.ext` |
| `fileType` | string | File extension (pdf, docx, xlsx, csv, txt) |
| `uploadedAt` | string | ISO timestamp when the document was uploaded |
| `chunks` | number | Number of text chunks stored for this document |

### Websites Array
Each website object contains:

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Full URL of the scraped page |
| `title` | string | Page title extracted during scraping |
| `scrapedAt` | string | ISO timestamp when the page was scraped |
| `chunks` | number | Number of text chunks stored for this page |

### Summary Object

| Field | Type | Description |
|-------|------|-------------|
| `totalDocuments` | number | Total number of unique documents |
| `totalWebsites` | number | Total number of unique website pages |
| `totalChunks` | number | Total number of vector chunks across all sources |

---

## Use Cases

### 1. Display User's Knowledge Base
Show users what data is available for their chatbot to answer questions from:

```bash
# Get all sources
curl -X GET http://localhost:3000/api/auth/scraper/sources \
  -H "Cookie: access_token=YOUR_TOKEN"
```

### 2. Verify Upload Success
After uploading documents or scraping websites, verify they appear in the sources list:

```bash
# Upload a document
curl -X POST http://localhost:3000/api/auth/documents/upload \
  -H "Cookie: access_token=YOUR_TOKEN" \
  -F "document=@report.pdf"

# Check if it appears in sources
curl -X GET http://localhost:3000/api/auth/scraper/sources \
  -H "Cookie: access_token=YOUR_TOKEN"
```

### 3. Track Storage Usage
Monitor how many chunks are being stored:

```bash
curl -X GET http://localhost:3000/api/auth/scraper/sources \
  -H "Cookie: access_token=YOUR_TOKEN" | jq '.data.summary.totalChunks'
```

---

## Empty Response

If the user has no stored data:

```json
{
  "success": true,
  "message": "Sources retrieved successfully",
  "data": {
    "documents": [],
    "websites": [],
    "summary": {
      "totalDocuments": 0,
      "totalWebsites": 0,
      "totalChunks": 0
    }
  }
}
```

---

## Error Responses

### Unauthorized (401)
```json
{
  "success": false,
  "message": "User not authenticated"
}
```

### Internal Server Error (500)
```json
{
  "success": false,
  "message": "Internal server error while fetching sources",
  "error": "Error details here"
}
```

---

## How It Works

1. **Authentication**: User must be logged in with valid JWT token
2. **Namespace Query**: Queries user's Pinecone namespace (`user_{userId}`)
3. **Source Aggregation**: Groups vector chunks by their source URL
4. **Classification**: Separates documents (URLs starting with `document://`) from websites (HTTP URLs)
5. **Sorting**: Returns sources sorted by upload/scrape time (most recent first)
6. **Chunk Counting**: Counts total chunks per source for visibility

---

## Integration Example

### Frontend Dashboard

```javascript
async function fetchUserSources() {
  const response = await fetch('http://localhost:3000/api/auth/scraper/sources', {
    credentials: 'include', // Include cookies
  });

  const data = await response.json();

  if (data.success) {
    console.log(`Documents: ${data.data.summary.totalDocuments}`);
    console.log(`Websites: ${data.data.summary.totalWebsites}`);
    console.log(`Total Chunks: ${data.data.summary.totalChunks}`);

    // Display documents
    data.data.documents.forEach(doc => {
      console.log(`- ${doc.filename} (${doc.fileType}) - ${doc.chunks} chunks`);
    });

    // Display websites
    data.data.websites.forEach(site => {
      console.log(`- ${site.title} - ${site.chunks} chunks`);
    });
  }
}
```

---

## Performance Notes

- **Query Limit**: Retrieves up to 10,000 vectors (Pinecone limit)
- **Response Time**: ~1-3 seconds depending on data volume
- **Caching**: Consider caching this data on the frontend as it doesn't change frequently

---

## Related Endpoints

- **POST /api/auth/documents/upload** - Upload documents
- **POST /api/auth/scraper/scrape** - Scrape websites
- **DELETE /api/auth/scraper/delete** - Delete specific source
- **DELETE /api/auth/scraper/delete-all** - Delete all sources
- **GET /api/auth/scraper/stats** - Get Pinecone statistics

---

## Notes

- Sources are sorted by date (most recent first)
- Each source shows the number of chunks it was split into
- Document URLs use special `document://` protocol
- Website URLs are standard HTTP/HTTPS URLs
- The API automatically distinguishes between documents and websites based on URL format
