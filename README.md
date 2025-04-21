# Task Assistant API

An intelligent API that helps users organize their day by suggesting relevant tasks based on their goals. The API can ask clarifying questions, search the web for information, and generate actionable tasks with time estimates.

## Features

- Chat-based conversation system with persistent sessions
- Intelligent questioning to clarify user goals
- Web search capabilities using Tavily
- Task generation with titles, descriptions, and time estimates
- Specialized assistance for SEO and website improvement

## API Endpoints

### Start or continue a chat

```
POST /chat
```

**Request Body (Starting a new chat):**
```json
{
  "message": "I need to improve the SEO for my e-commerce website"
}
```

**Response (First interaction):**
```json
{
  "sessionId": "123e4567-e89b-12d3-a456-426614174000",
  "tasks": [],
  "reply": "What type of e-commerce website do you have? Could you share the URL and tell me what products you sell?"
}
```

**Request Body (Continuing a chat):**
```json
{
  "sessionId": "123e4567-e89b-12d3-a456-426614174000",
  "message": "I sell handmade jewelry at www.example.com"
}
```

**Response (After sufficient information):**
```json
{
  "sessionId": "123e4567-e89b-12d3-a456-426614174000",
  "tasks": [
    {
      "title": "Keyword Research for E-commerce SEO",
      "description": "Identify high-value keywords for your handmade jewelry niche. Use tools like Google Keyword Planner, Ubersuggest, or SEMrush to find keywords with good search volume and low competition. Focus on long-tail keywords that potential customers might use when looking for specific types of jewelry or materials.",
      "timeEstimate": "2 hours"
    },
    {
      "title": "Optimize Product Descriptions",
      "description": "Revise product descriptions to include target keywords naturally. Each product should have at least 300 words of unique content that describes materials, dimensions, crafting process, and potential uses or occasions. Include alt text for all product images with descriptive keywords.",
      "timeEstimate": "3 hours"
    },
    {
      "title": "Improve Site Structure and Internal Linking",
      "description": "Organize products into logical categories and implement breadcrumb navigation. Create internal links between related products and from blog posts to relevant product pages. Ensure your site has a clear hierarchy that helps both users and search engines understand your content organization.",
      "timeEstimate": "2.5 hours"
    }
  ],
  "reply": null
}
```

### Clear chat history

```
DELETE /chat/:sessionId
```

**Response:**
```json
{
  "success": true
}
```

## Setup

1. Clone the repository
2. Install dependencies:
```
npm install
```
3. Create a `.env` file with your API keys:
```
OPENAI_API_KEY=your_openai_api_key
TAVILY_API_KEY=your_tavily_api_key
```
4. Start the server:
```
npm start
```

## Example Usage

The API is designed to have a conversation with the user, ask clarifying questions when needed, and eventually provide specific, actionable tasks formatted as structured JSON objects. Here's an example flow:

1. User: "I want to improve my website's SEO"
2. Assistant: (reply contains conversation questions) "I'd be happy to help with that. Could you tell me more about your website? What is the URL and what kind of content or products does it offer?"
3. User: "It's a photography portfolio at example.com"
4. Assistant: (tasks contains structured JSON array)
   ```json
   [
     {
       "title": "Optimize Image Alt Tags",
       "description": "Add descriptive alt text to all portfolio images using relevant keywords that describe the image content, subject, and photography style. Ensure alt text is concise but informative.",
       "timeEstimate": "30 minutes"
     },
     {
       "title": "Create a Blog Section",
       "description": "Add a blog to share photography tips, behind-the-scenes content, and photo stories. Create at least 5 initial posts (500+ words each) targeting keywords relevant to your photography style and services.",
       "timeEstimate": "2 hours"
     },
     {
       "title": "Improve Page Loading Speed",
       "description": "Compress all portfolio images without losing quality using tools like ShortPixel or TinyPNG. Implement lazy loading so images only load when a user scrolls to them. Use Google PageSpeed Insights to identify and fix other loading issues.",
       "timeEstimate": "1 hour"
     }
   ]
   ```

## Example Usage with curl

Start a new chat:
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "I need help with my website SEO"}'
```

Continue a chat using the sessionId from the previous response:
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "123e4567-e89b-12d3-a456-426614174000", "message": "My website is example.com and I sell handmade jewelry"}'
```

Clear a chat session:
```bash
curl -X DELETE http://localhost:3000/chat/123e4567-e89b-12d3-a456-426614174000
```

## Example Usage with JavaScript

```javascript
// Example with fetch API
async function startChat() {
  const response = await fetch('http://localhost:3000/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'I need help improving my website conversions'
    }),
  });
  
  const data = await response.json();
  const sessionId = data.sessionId;
  console.log('Reply:', data.reply);
  
  // Later, continue the conversation
  const secondResponse = await fetch('http://localhost:3000/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: sessionId,
      message: 'It\'s an e-commerce site selling electronics at techstore.com'
    }),
  });
  
  const secondData = await secondResponse.json();
  
  if (secondData.tasks && secondData.tasks.length > 0) {
    console.log('Tasks generated:');
    secondData.tasks.forEach((task, index) => {
      console.log(`Task ${index + 1}: ${task.title} (${task.timeEstimate})`);
      console.log(`Description: ${task.description}`);
      console.log('---');
    });
  } else if (secondData.reply) {
    console.log('Reply:', secondData.reply);
  }
}

startChat();
``` 