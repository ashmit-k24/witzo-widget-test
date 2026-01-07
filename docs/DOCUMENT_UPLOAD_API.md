# Document Upload API

## Overview

The Document Upload API allows authenticated users to upload documents (PDF, Word, Excel, CSV, TXT) which will be automatically parsed, processed, and stored in Pinecone in the same user namespace as their scraped web content.

## Features

- ✅ **Multiple file formats**: PDF, Word (.doc/.docx), Excel (.xls/.xlsx), CSV, TXT
- ✅ **Automatic content extraction**: Parses document content intelligently
- ✅ **Same namespace**: Stored with scraped web data for unified search
- ✅ **Batch upload**: Upload multiple documents at once
- ✅ **Size limit**: 10MB per file
- ✅ **Automatic cleanup**: Temporary files deleted after processing

---

## Supported File Types

| Format | Extensions | Description |
|--------|------------|-------------|
| **PDF** | `.pdf` | Extracts text content from PDF files |
| **Word** | `.doc`, `.docx` | Extracts text from Microsoft Word documents |
| **Excel** | `.xls`, `.xlsx` | Converts spreadsheet data to text format |
| **CSV** | `.csv` | Parses CSV data with headers |
| **Text** | `.txt` | Plain text files |

---

## API Endpoints

### 1. **POST /api/auth/documents/upload** - Upload Single Document

Upload a single document file.

**Authentication**: Required (JWT token)

**Request Type**: `multipart/form-data`

**Form Field**: `document` (file)

**CURL Example:**
```bash
curl -X POST http://localhost:3000/api/auth/documents/upload \
  -H "Cookie: access_token=YOUR_ACCESS_TOKEN" \
  -F "document=@/path/to/your/file.pdf"
```

**Response:**
```json
{
  "success": true,
  "message": "Document processed and stored successfully",
  "data": {
    "filename": "report.pdf",
    "fileType": "pdf",
    "size": 524288,
    "chunks": 3,
    "processedAt": "2026-01-06T12:00:00.000Z"
  }
}
```

---

### 2. **POST /api/auth/documents/upload-multiple** - Upload Multiple Documents

Upload up to 10 documents at once.

**Authentication**: Required (JWT token)

**Request Type**: `multipart/form-data`

**Form Field**: `documents` (array of files, max 10)

**CURL Example:**
```bash
curl -X POST http://localhost:3000/api/auth/documents/upload-multiple \
  -H "Cookie: access_token=YOUR_ACCESS_TOKEN" \
  -F "documents=@/path/to/file1.pdf" \
  -F "documents=@/path/to/file2.docx" \
  -F "documents=@/path/to/file3.csv"
```

**Response:**
```json
{
  "success": true,
  "message": "Processed 3 out of 3 files successfully",
  "data": {
    "totalFiles": 3,
    "successCount": 3,
    "failedCount": 0,
    "results": [
      {
        "filename": "file1.pdf",
        "success": true,
        "chunks": 2
      },
      {
        "filename": "file2.docx",
        "success": true,
        "chunks": 1
      },
      {
        "filename": "file3.csv",
        "success": true,
        "chunks": 1
      }
    ]
  }
}
```

---

## How It Works

### Processing Flow

```
Upload Document
      ↓
Validate File Type
      ↓
Save to Temporary Directory
      ↓
Parse Content (PDF/Word/Excel/CSV/TXT)
      ↓
Extract Text Content
      ↓
Chunk Content (8000 chars per chunk)
      ↓
Generate Embeddings (OpenAI)
      ↓
Store in Pinecone (user's namespace)
      ↓
Delete Temporary File
      ↓
Return Success Response
```

### Document URL Format

Documents are stored with a special URL format:
```
document://filename.pdf
```

This allows you to:
- Distinguish documents from web pages
- Query/delete documents separately if needed
- Track source of information in chat responses

---

## Integration with Other Features

### 1. **Chat API Integration**

Documents are stored in the same namespace as scraped web content, so the Chat API automatically searches through:
- ✅ Scraped website content
- ✅ Uploaded documents

**Example:**
```bash
# Upload a product manual PDF
curl -X POST http://localhost:3000/api/auth/documents/upload \
  -b cookies.txt \
  -F "document=@product_manual.pdf"

# Ask questions about it (same userId)
curl -X POST http://localhost:3000/api/auth/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "message": "How do I install the product?"
  }'

# AI will answer using content from the PDF!
```

### 2. **Delete Documents**

Use the same delete endpoint to remove documents:

```bash
# Delete a specific document
curl -X DELETE http://localhost:3000/api/auth/scraper/delete \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -H "x-csrf-token: YOUR_CSRF_TOKEN" \
  -d '{
    "url": "document://product_manual.pdf"
  }'

# Delete all user data (web + documents)
curl -X DELETE http://localhost:3000/api/auth/scraper/delete-all \
  -b cookies.txt \
  -H "x-csrf-token: YOUR_CSRF_TOKEN"
```

---

## File Format Details

### PDF Files
- Extracts all text content
- Preserves text structure
- Works with text-based PDFs (not scanned images)

### Word Documents (.doc/.docx)
- Extracts raw text content
- Removes formatting
- Preserves paragraph structure

### Excel Files (.xls/.xlsx)
- Processes all sheets
- Converts to readable text format
- Format: `Column: Value | Column: Value`

### CSV Files
- Parses with headers
- Each row as: `Header1: Value1, Header2: Value2`
- Skips empty lines

### Text Files (.txt)
- Direct content extraction
- No processing needed

---

## Error Responses

### No File Uploaded
```json
{
  "success": false,
  "message": "No file uploaded"
}
```

### Invalid File Type
```json
{
  "success": false,
  "message": "Invalid file type. Allowed types: PDF, Word (doc/docx), Excel (xls/xlsx), CSV, TXT"
}
```

### File Too Large
```json
{
  "success": false,
  "message": "File too large. Maximum size: 10MB"
}
```

### Processing Error
```json
{
  "success": false,
  "message": "Internal server error while processing document",
  "error": "Failed to parse PDF file"
}
```

### Authentication Required
```json
{
  "success": false,
  "message": "User not authenticated"
}
```

---

## Complete Workflow Example

```bash
# 1. Authenticate (get access token)
curl -X POST http://localhost:3000/api/auth/verify \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{
    "email": "user@example.com",
    "code": "123456"
  }'

# 2. Scrape a website
curl -X POST http://localhost:3000/api/auth/scraper/scrape \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "maxDepth": 2,
    "maxPages": 20
  }'

# 3. Upload related documents
curl -X POST http://localhost:3000/api/auth/documents/upload-multiple \
  -b cookies.txt \
  -F "documents=@manual.pdf" \
  -F "documents=@specs.docx" \
  -F "documents=@data.csv"

# 4. Chat with combined knowledge (web + documents)
curl -X POST http://localhost:3000/api/auth/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "your-user-id",
    "message": "What are the technical specifications?"
  }'

# AI searches through BOTH scraped web content AND uploaded documents!
```

---

## Best Practices

1. **File Naming**: Use descriptive filenames (they're stored as-is)
2. **Size Optimization**: Compress large PDFs before uploading
3. **Batch Upload**: Upload related documents together
4. **Text-based PDFs**: Ensure PDFs contain selectable text (not scanned images)
5. **Clean Data**: Use well-formatted CSV/Excel files for better results

---

## Limitations

- **File Size**: 10MB maximum per file
- **Batch Limit**: Maximum 10 files per batch upload
- **Format Support**: Only listed formats (no images, videos, etc.)
- **Scanned PDFs**: OCR not supported (text-based PDFs only)
- **Temporary Storage**: Files deleted immediately after processing

---

## Technical Details

### Storage Location
- Temporary files: `uploads/` directory
- Vectors: Pinecone namespace `user_{userId}`

### Content Chunking
- **Chunk Size**: 8000 characters
- **Method**: Sentence-based chunking
- **Overlap**: Minimal sentence overlap

### Metadata Stored
- `url`: `document://filename.ext`
- `title`: Original filename
- `fileType`: File extension
- `size`: File size in bytes
- `uploadedAt`: ISO timestamp
- `userId`: User identifier
- `chunkIndex`: Chunk number
- `totalChunks`: Total chunks for document

---

## Security

- ✅ **Authentication Required**: Only logged-in users can upload
- ✅ **File Type Validation**: Strict whitelist of allowed formats
- ✅ **Size Limits**: Prevents abuse with 10MB limit
- ✅ **User Isolation**: Documents stored in user-specific namespace
- ✅ **Automatic Cleanup**: Temporary files deleted after processing
- ✅ **No Public Access**: Documents not directly accessible via URL

---

## Notes

- Documents and web content coexist in the same namespace
- Chat API automatically searches through both sources
- Delete operations affect both web and document content
- Processing time varies by file size and format
- Failed uploads don't affect existing data
