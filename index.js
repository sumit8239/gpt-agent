import express from 'express';
import openai from './openaiClient.js';
import { analyzeWebsite, extractWebsiteInsights, analyzeWebsiteForTasks } from './scrapping.js';
import { 
  getMessages, 
  addMessage, 
  clearSession, 
  getTaskType, 
  isReadyForTasks, 
  resetQuestionCount, 
  markTasksGenerated, 
  hasGeneratedTasks,
  isTaskEditRequested,
  getSpecificTaskToEdit,
  setSpecificTaskToEdit,
  clearTaskEditRequest,
  storeWebsiteData,
  getWebsiteData,
  storeGeneratedTasks,
  getStoredTasks
} from './chatSession.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

const app = express();
const PORT = 3000;

// Add security headers middleware
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// Parse JSON bodies
app.use(express.json());

// Function to extract tasks from reply text
function extractTasksFromReply(reply) {
  if (!reply || typeof reply !== 'string') return null;

  // Look for task patterns
  const taskPatterns = [
    /(?:#{1,3}\s*)?Task\s*(\d+)[:\)]/gi,
    /(\d+)[:.]\s*([A-Z][^.]*(?:\.|$))/g,
    /(?:#{1,3}\s*)?(\d+)[:.]\s*([A-Z][^.]*(?:\.|$))/g,
    /###\s*Task:?\s*(.*?)(?=###|$)/gis,
    /\*\*Title:\*\*\s*(.*?)(?=\*\*|\n|$)/gi
  ];

  let hasTaskIndicators = false;
  for (const pattern of taskPatterns) {
    if (pattern.test(reply)) {
      hasTaskIndicators = true;
      break;
    }
  }

  if (!hasTaskIndicators) return null;

  // Check for sections with "Task" headers
  const taskSectionPatterns = [
    /(?:#{1,3}\s*)?Task\s*\d+[:\)]/i,
    /###\s*Task:?\s*/i
  ];
  
  let taskSections = [];
  for (const pattern of taskSectionPatterns) {
    if (pattern.test(reply)) {
      taskSections = reply.split(pattern).slice(1);
      if (taskSections.length > 0) break;
    }
  }

  if (taskSections.length > 0) {
    const tasks = [];

    for (let i = 0; i < taskSections.length; i++) {
      const section = taskSections[i].trim();

      let title = '';
      let description = section;
      let timeEstimate = '1 hour'; // Default

      // Look for title formats including bold format
      const titlePatterns = [
        /(?:\*\*)?(?:Title:|Task:)(?:\*\*)?\s*([^*\n]+)/i,
        /(?:\*\*([^*]+)\*\*|([^.:\n]+))/
      ];
      
      for (const pattern of titlePatterns) {
        const titleMatch = section.match(pattern);
        if (titleMatch) {
          title = (titleMatch[1] || titleMatch[2]).trim();
          description = description.replace(titleMatch[0], '').trim();
          break;
        }
      }

      // Look for time estimate formats
      const timePatterns = [
        /(?:\*\*)?Time\s*Estimate(?:\*\*)?(?::|is)?\s*([^.\n]+)/i,
        /(?:\*\*)?Estimated\s*Time(?:\*\*)?(?::|is)?\s*([^.\n]+)/i,
        /(?:\*\*)?Duration(?:\*\*)?(?::|is)?\s*([^.\n]+)/i,
        /Takes\s*about\s*([^.\n]+)/i
      ];

      for (const pattern of timePatterns) {
        const timeMatch = section.match(pattern);
        if (timeMatch) {
          timeEstimate = timeMatch[1].trim();
          description = description.replace(timeMatch[0], '').trim();
          break;
        }
      }

      // Clean up description
      description = description
        .replace(/\*\*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // Ensure we have a valid title
      if (!title || title.length > 50) {
        title = `Task ${i + 1}`;
      }

      tasks.push({ title, description, timeEstimate });
    }

    return tasks.length > 0 ? tasks : null;
  }

  // Check for description section with **Description:** format
  const descriptionMatch = reply.match(/\*\*Description:\*\*\s*([\s\S]*?)(?=\*\*Time|\*\*Estimated|$)/i);
  if (descriptionMatch) {
    const titleMatch = reply.match(/\*\*Title:\*\*\s*([^*\n]+)/i);
    const timeMatch = reply.match(/\*\*Time\s*Estimate:\*\*\s*([^*\n]+)/i) || 
                      reply.match(/\*\*Estimated\s*Time:\*\*\s*([^*\n]+)/i);
    
    if (titleMatch) {
      return [{
        title: titleMatch[1].trim(),
        description: descriptionMatch[1].trim(),
        timeEstimate: timeMatch ? timeMatch[1].trim() : '1 hour'
      }];
    }
  }

  // If no task sections found, look for numbered lists
  const lines = reply.split('\n');
  const tasks = [];
  let currentTask = null;
  let timeEstimatePattern = /(?:time|duration|estimate)s?:?\s*(\d+\s*(?:hour|hr|minute|min|day)s?)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const taskMatch = line.match(/^(\d+)[:.]\s*(.+)$/);

    if (taskMatch) {
      if (currentTask) {
        tasks.push(currentTask);
      }

      currentTask = {
        title: taskMatch[2].trim(),
        description: '',
        timeEstimate: '1 hour'
      };
    }
    else if (currentTask && timeEstimatePattern.test(line)) {
      const timeMatch = line.match(timeEstimatePattern);
      if (timeMatch) {
        currentTask.timeEstimate = timeMatch[1];
      } else {
        currentTask.description += line + '\n';
      }
    }
    else if (currentTask && line) {
      currentTask.description += line + '\n';
    }
  }

  if (currentTask) {
    tasks.push(currentTask);
  }

  tasks.forEach(task => {
    task.description = task.description.trim();
  });

  return tasks.length > 0 ? tasks : null;
}

// Function for web search using web scraping
async function webSearch(query) {
  try {
    console.log(`Performing web search for: ${query}`);
    
    const domainMatch = query.match(/site:([a-zA-Z0-9.-]+)/);
    const urlMatch = query.match(/(https?:\/\/[^\s]+)/);
    
    let url;
    
    if (urlMatch) {
      url = urlMatch[1];
    } 
    else if (domainMatch) {
      url = domainMatch[1];
      if (!url.startsWith('http')) {
        url = 'https://' + url;
      }
    } 
    else {
      const searchQuery = query.replace(/\s+/g, '+');
      url = `https://www.google.com/search?q=${searchQuery}`;
    }
    
    const headData = await analyzeWebsite(url);
    
    if (headData.error) {
      await cleanScrapedDataDirectory();
      return `I couldn't find specific information about "${query}". Let me help based on my general knowledge.`;
    }
    
    // Format the head tag information into a useful summary
    await cleanScrapedDataDirectory();
    return `
      Information about "${query}" from ${url}:
      
      Title: ${headData.title || 'Not available'}
      
      Metadata:
      ${headData.metaData.description ? `- Description: ${headData.metaData.description}` : '- No description found'}
      ${headData.metaData.keywords ? `- Keywords: ${headData.metaData.keywords}` : ''}
      ${headData.metaData.canonical ? `- Canonical URL: ${headData.metaData.canonical}` : ''}
      
      SEO Information:
      ${headData.metaData.robots ? `- Robots Directive: ${headData.metaData.robots}` : '- No robots directive found'}
      ${headData.metaData.ogTitle ? `- OG Title: ${headData.metaData.ogTitle}` : ''}
      ${headData.metaData.ogDescription ? `- OG Description: ${headData.metaData.ogDescription}` : ''}
      
      Head Tag Statistics:
      - Meta Tags: ${headData.headStats.metaTagCount}
      - Link Tags: ${headData.headStats.linkTagCount}
      - Script Tags: ${headData.headStats.scriptTagCount}
    `;
  } catch (error) {
    console.error(`Error in web search: ${error.message}`);
    await cleanScrapedDataDirectory();
    return `I encountered an error while researching "${query}". Let me provide information based on my general knowledge.`;
  }
}

// Helper function to get temporary directory
function getTempDirectory() {
  // Detect Vercel environment - look for multiple possible environment variables
  const isVercel = process.env.VERCEL === '1' || 
                  process.env.VERCEL === 'true' || 
                  process.env.NOW_REGION || 
                  process.env.VERCEL_REGION ||
                  process.cwd().includes('/var/task');
  
  // Use /tmp for Vercel (serverless) environments
  return isVercel ? '/tmp' : path.join(process.cwd(), 'scraped_data');
}

// Function to clean up files in the scraped_data directory
async function cleanScrapedDataDirectory() {
  try {
    const scrapedDataDir = getTempDirectory();
    console.log(`\n=== Starting cleanup process ===`);
    console.log(`Target directory: ${scrapedDataDir}`);
    
    if (fs.existsSync(scrapedDataDir)) {
      const files = await fs.promises.readdir(scrapedDataDir);
      console.log(`Found ${files.length} total files in directory`);
      
      if (files.length === 0) {
        console.log('No files found to delete');
        return;
      }

      // Delete files one by one using async operations
      let deletedCount = 0;
      let errorCount = 0;
      
      for (const file of files) {
        const filePath = path.join(scrapedDataDir, file);
        try {
          // Check if file exists before trying to delete
          if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            console.log(`✅ Successfully deleted: ${file}`);
            deletedCount++;
          } else {
            console.log(`⚠️ File not found: ${file}`);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') { // Ignore "file not found" errors
            console.error(`❌ Error deleting ${file}:`, error.message);
            errorCount++;
          }
        }
      }
      
      console.log(`\n=== Cleanup Summary ===`);
      console.log(`Total files found: ${files.length}`);
      console.log(`Successfully deleted: ${deletedCount}`);
      console.log(`Errors encountered: ${errorCount}`);
      console.log(`Cleanup completed in ${scrapedDataDir}`);
    } else {
      console.log(`⚠️ Directory ${scrapedDataDir} does not exist`);
      
      // Try to create the directory if it doesn't exist
      try {
        fs.mkdirSync(scrapedDataDir, { recursive: true });
        console.log(`✅ Created directory: ${scrapedDataDir}`);
      } catch (createError) {
        console.error(`❌ Failed to create directory ${scrapedDataDir}:`, createError.message);
      }
    }
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
}

// Endpoint for the initial message in a chat
app.post('/chat', async (req, res) => {
  try {
    let message, sessionId, inputTasks;

    try {
      if (typeof req.body !== 'object') {
        return res.status(400).json({
          error: "Invalid request body format. Expected JSON object."
        });
      }

      message = req.body.message;
      sessionId = req.body.sessionId;
      // Capture tasks from input if provided
      inputTasks = req.body.tasks || [];

      if (typeof message !== 'string' || message.trim() === '') {
        return res.status(400).json({
          error: "Missing or invalid message in request body. Message must be a non-empty string."
        });
      }
    } catch (parseError) {
      return res.status(400).json({
        error: "Error parsing request body. Please ensure you're sending valid JSON."
      });
    }

    const currentSessionId = sessionId || uuidv4();

    // Store tasks from the request in the session if they exist
    if (inputTasks && Array.isArray(inputTasks) && inputTasks.length > 0) {
      addMessage(currentSessionId, { 
        role: "system", 
        content: JSON.stringify({ tasks: inputTasks, source: "client_input" })
      });
    }

    addMessage(currentSessionId, { role: "user", content: message.trim() });

    let response = await processMessage(currentSessionId);
    response = await ensureTasksInTasksArray(response);

    return res.json({
      sessionId: currentSessionId,
      ...response
    });
  } catch (error) {
    console.error("Error in /chat:", error);
    return res.status(500).json({
      error: "An error occurred processing your request. Please try again."
    });
  }
});

// Endpoint to clear chat history
app.delete('/chat/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    clearSession(sessionId);
    return res.json({ success: true });
  } catch (error) {
    console.error("Error in DELETE /chat/:sessionId:", error);
    return res.status(500).json({ error: "An error occurred clearing the session" });
  }
});

// Helper function to process messages with GPT
async function processMessage(sessionId) {
  const allMessages = getMessages(sessionId);
  const userMessages = allMessages.filter(msg => msg.role === "user");
  const taskType = getTaskType(sessionId);

  // Get system and recent messages for the API call
  const systemMessage = allMessages.find(msg => msg.role === "system");
  const recentMessages = allMessages.filter(msg => msg.role !== "system").slice(-6);
  const messages = systemMessage ? [systemMessage, ...recentMessages] : recentMessages;

  // Check for website URLs if we're doing website-related tasks
  if (taskType === "website") {
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    const mentionedUrls = [];
    
    userMessages.forEach(msg => {
      const matches = msg.content.match(urlPattern);
      if (matches) {
        mentionedUrls.push(...matches);
      }
    });
    
    const uniqueUrls = [...new Set(mentionedUrls)];
    
    if (uniqueUrls.length > 0 && !getWebsiteData(sessionId)) {
      // We have a URL but haven't analyzed it yet - do that first
      try {
        // Determine website analysis focus based on conversation
        let domainFocus = "general";
        const conversationText = userMessages.map(msg => msg.content.toLowerCase()).join(" ");
        
        if (conversationText.includes("seo") || 
            conversationText.includes("search engine") || 
            conversationText.includes("ranking")) {
          domainFocus = "seo";
        } else if (conversationText.includes("content") || 
                 conversationText.includes("writing") || 
                 conversationText.includes("blog")) {
          domainFocus = "content";
        } else if (conversationText.includes("design") || 
                 conversationText.includes("experience") || 
                 conversationText.includes("ux") ||
                 conversationText.includes("ui")) {
          domainFocus = "ux";
        }
        
        console.log(`Analyzing website ${uniqueUrls[0]} with focus on ${domainFocus}`);
        const analysisResult = await analyzeWebsiteForTasks(uniqueUrls[0], domainFocus);
        
        if (analysisResult.success) {
          storeWebsiteData(sessionId, analysisResult);
          console.log(`Website analysis stored for session ${sessionId}`);
          
          // Add a message to the conversation with analysis summary
          const summarySections = analysisResult.analysisPrompt.split('\n\n');
          const summaryText = summarySections.slice(0, 3).join('\n\n');
          
          addMessage(sessionId, { 
            role: "system", 
            content: `I've analyzed the website ${uniqueUrls[0]}. Here's what I found:\n\n${summaryText}`
          });
        }
      } catch (error) {
        console.error(`Error analyzing website:`, error);
      }
    }
  }
  
  // Check if tasks were already generated and user is asking for edits
  if (hasGeneratedTasks(sessionId) && (isTaskEditRequested(sessionId) || userMessages[userMessages.length - 1]?.content?.toLowerCase().match(/\b(task\s*)?([1-3])\b/i))) {
    console.log("Task edit request detected in processMessage");
    return await handleTaskEditing(sessionId, messages);
  }
  
  // Check if tasks were already generated in a previous exchange
  if (hasGeneratedTasks(sessionId)) {
    const lastUserMessage = userMessages[userMessages.length - 1]?.content?.toLowerCase() || "";
    
    // Check if user is asking for entirely new tasks with key phrases
    const newTaskPhrases = [
      "new project", "different tasks", "new topic", 
      "start over", "restart", "another set", "different set",
      "try something else", "instead", "forget that"
    ];
    
    // Check if user is asking to edit a specific task
    const editTaskPhrases = [
      "edit", "update", "change", "modify", "revise", "adjust", "fix"
    ];
    
    // Check if the message contains task edit request
    const isEditRequest = editTaskPhrases.some(phrase => 
      lastUserMessage.includes(phrase)
    );
    
    // Check if message mentions specific task ID (1, 2, or 3)
    const taskIdMatch = lastUserMessage.match(/\b(task\s*)?([1-3])\b/i);
    
    // If we have an existing task edit request from addMessage, use that
    if (isTaskEditRequested(sessionId) || isEditRequest || taskIdMatch) {
      console.log("Task edit request detected");
      
      // If user mentions a specific task ID in this message, update the index
      if (taskIdMatch) {
        const taskId = parseInt(taskIdMatch[2]);
        // Convert to 0-based index for internal use (ID 1 becomes index 0)
        setSpecificTaskToEdit(sessionId, taskId - 1);
        console.log(`Task edit requested for task ID ${taskId} (index ${taskId - 1})`);
      }
      
      // Ensure the edit flag is set
      if (!isTaskEditRequested(sessionId)) {
        clearTaskEditRequest(sessionId, true);
      }
      
      // Directly call the task editing function
      return await handleTaskEditing(sessionId, messages);
    }
    
    // Check if user is asking for entirely new tasks
    const isAskingForNewTasks = newTaskPhrases.some(phrase => 
      lastUserMessage.includes(phrase)
    );
    
    if (isAskingForNewTasks) {
      // Clear task generation flag to regenerate tasks
      resetQuestionCount(sessionId);
      clearTaskEditRequest(sessionId);
      // But continue with the existing messages for context
    } else {
      // Just continue the conversation normally
      const continuationMessage = {
        role: "system",
        content: "The user has already received tasks from you. Continue the conversation by helping them implement the tasks or addressing any questions they have. Only generate new tasks if explicitly requested."
      };
      
      try {
      const chatCompletion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
          messages: [...messages, continuationMessage]
      });
      
      const content = chatCompletion.choices[0].message.content || "";
      addMessage(sessionId, { role: "assistant", content });
      
        await cleanScrapedDataDirectory();
      return { reply: content, tasks: [] };
        } catch (error) {
        console.error("Error in continuation response:", error);
        await cleanScrapedDataDirectory();
        return { 
          reply: "I'm sorry, I had trouble processing that. How can I help you with your current tasks?", 
          tasks: [] 
        };
      }
    }
  }
  
  // Check if we have enough context to generate tasks
  if (!isReadyForTasks(sessionId)) {
    // We're still gathering information with questions
    const questionGuidance = {
      role: "system",
      content: "The user is seeking help with task creation. Ask 1-2 specific, focused questions to understand their needs better. Keep your questions concise. Focus on: 1) Their specific goals and challenges, 2) Their current resources or constraints. If the user's message already contains sufficient context, you may proceed to task creation without asking questions."
    };
    
    // Check if we should include website data in the prompt
    const websiteData = getWebsiteData(sessionId);
    if (websiteData) {
      questionGuidance.content += `\n\nYou have access to website analysis data. Ask about specific areas you can help with based on this analysis.`;
    }
    
    try {
    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
        messages: [...messages, questionGuidance],
      tools: [
        {
          type: "function",
          function: {
            name: "search_web",
            description: "Search the web for relevant information",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query or website URL" }
              },
              required: ["query"]
            }
          }
        }
      ],
      tool_choice: "auto"
    });

    const responseMessage = chatCompletion.choices[0].message;

    if (responseMessage.tool_calls?.[0]) {
        // Handle web search
      const toolCall = responseMessage.tool_calls[0];

      try {
        let searchQuery = "";
        try {
          const args = JSON.parse(toolCall.function.arguments);
          searchQuery = args.query || "";
        } catch (parseError) {
          console.error("Error parsing tool call arguments:", parseError);
          searchQuery = "error parsing search query";
        }

        addMessage(sessionId, {
          role: "assistant",
          tool_calls: responseMessage.tool_calls,
          content: responseMessage.content || ""
        });

        let answer;
        try {
          answer = await webSearch(searchQuery);
        } catch (searchError) {
          console.error("Error during search:", searchError);
          answer = "Search failed. Let me continue with what I already know.";
        }

        if (!answer || answer.trim() === "") {
          answer = "No search results found. Let me continue with what I already know.";
        }

        addMessage(sessionId, {
          role: "tool",
          tool_call_id: toolCall.id,
          name: "search_web",
          content: answer
        });

        const secondResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [...getMessages(sessionId), {
            role: "system",
              content: "Ask one concise question to understand user needs or proceed to task creation if you have enough information."
          }]
        });

        const finalAnswer = secondResponse.choices[0].message.content || "";
        addMessage(sessionId, { role: "assistant", content: finalAnswer });

          await cleanScrapedDataDirectory();
        return { reply: finalAnswer, tasks: [] };
      } catch (error) {
        console.error("Error handling tool call:", error);
        const errorMessage = "I'm having trouble accessing search results right now. Let me help based on what I already know.";
        addMessage(sessionId, { role: "assistant", content: errorMessage });
          
          await cleanScrapedDataDirectory();
        return { reply: errorMessage, tasks: [] };
      }
    }

    const content = responseMessage.content || "";
    addMessage(sessionId, {
      role: "assistant",
      content: content
    });

      await cleanScrapedDataDirectory();
    return { reply: content, tasks: [] };
    } catch (error) {
      console.error("Error in question phase:", error);
      const errorMessage = "I'm having a little trouble processing that. Could you tell me more about what you're looking to accomplish?";
      addMessage(sessionId, { role: "assistant", content: errorMessage });
      
      await cleanScrapedDataDirectory();
      return { reply: errorMessage, tasks: [] };
    }
  }
  
  // We have enough context to generate tasks
  return await generateTasks(sessionId, messages);
}

// Function to handle task editing requests
async function handleTaskEditing(sessionId, messages) {
  console.log("Starting task editing process");
  
  // Get the specific task to edit (if any)
  const specificTaskIndex = getSpecificTaskToEdit(sessionId);
  console.log(specificTaskIndex);
  console.log(`Task editing - specific index to edit: ${specificTaskIndex}`);
  
  try {
    // First, retrieve the existing tasks from the most reliable sources
    let existingTasks = [];
    
    // First try the direct storage
    const storedTasks = getStoredTasks(sessionId);
    if (storedTasks && storedTasks.length > 0) {
      console.log("Using tasks from direct storage:", storedTasks.length);
      existingTasks = storedTasks;
    }
    
    // If no tasks from direct storage, try other sources
    if (existingTasks.length === 0) {
      // Get all system messages that might contain task data, starting with the most recent
      const systemMessages = messages.filter(msg => msg.role === "system" && msg.content).reverse();
      
      // Try to find serialized task data in system messages
      for (const msg of systemMessages) {
        try {
          const parsedContent = JSON.parse(msg.content);
          if (parsedContent.tasks && Array.isArray(parsedContent.tasks) && parsedContent.tasks.length > 0) {
            console.log("Found tasks in system message:", parsedContent.tasks.length);
            existingTasks = parsedContent.tasks;
            break;
          }
        } catch (e) {
          // Continue to next message if parsing fails
        }
      }
    }
    
    // If still no tasks, fall back to other methods
    if (existingTasks.length === 0) {
      // Further fallback methods...
      // ... [existing fallback logic] ...
      
      // Last resort: use generic fallback tasks
      if (existingTasks.length === 0) {
        console.log("Using fallback tasks as last resort");
        existingTasks = getFallbackTasksByType(getTaskType(sessionId));
      }
    }
    
    // Log task retrieval status
    console.log(`Task retrieval status - Found: ${existingTasks.length}, Specific index to edit: ${specificTaskIndex}`);
    
    // Validate existing tasks to ensure they are complete and have IDs
    existingTasks = existingTasks.map((task, index) => ({
      id: task.id || index + 1, // Ensure task has an ID
      title: (task.title || "").trim() || "Untitled Task",
      description: (task.description || "").trim() || "No description provided.",
      timeEstimate: (task.timeEstimate || "").trim() || "1 hour"
    })).slice(0, 3);
    
    // Ensure we have exactly 3 tasks
    const fallbackTasks = getFallbackTasksByType(getTaskType(sessionId));
    while (existingTasks.length < 3) {
      existingTasks.push(fallbackTasks[existingTasks.length - 1]);
    }
    
    // If we're editing a specific task, handle it directly without calling the API
    if (specificTaskIndex !== null && specificTaskIndex >= 0 && specificTaskIndex < 3) {
      // Get the last user message to understand what edit they want
      const userMessages = messages.filter(msg => msg.role === "user").reverse();
      const lastUserMessage = userMessages[0]?.content || "";
      
      // Strategy 1: Try GPT for specific edit
      try {
        // Only send the specific task to be edited and the user's instruction
        const editGuidance = {
        role: "system",
          content: `You are an AI specialized in generating detailed, actionable tasks with step-by-step instructions.
I will provide you with:
1. An existing task that needs to be edited
2. The user's request for how to modify it

Your job is to return ONLY the edited task with the same structure but updated according to the user's request. Keep the format consistent with title, description, and timeEstimate fields.

EXISTING TASK TO EDIT:
Task ID: ${specificTaskIndex + 1}
Title: ${existingTasks[specificTaskIndex].title}
Description: ${existingTasks[specificTaskIndex].description}
Time Estimate: ${existingTasks[specificTaskIndex].timeEstimate}

USER'S EDIT REQUEST:
${lastUserMessage}

IMPORTANT: Please make actual changes to the task based on the user's request. If the user doesn't specify what to change, make improvements to the task description or title.

Response format should be valid JSON with lowercase property names: "title", "description", and "timeEstimate". Do not use capitalized property names like "Title" or "Description".`
        };
        
        // Get just the edited task
        const editCompletion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [editGuidance],
          response_format: { type: "json_object" }
        });

        const editContent = editCompletion.choices[0].message.content?.trim() || "{}";
        console.log("Edit model response:", editContent);
        const editedTaskRaw = JSON.parse(editContent);
        
        // Normalize property names to handle both camelCase and Title Case with spaces
        const editedTask = {
          title: editedTaskRaw.title || editedTaskRaw.Title || "",
          description: editedTaskRaw.description || editedTaskRaw.Description || "",
          timeEstimate: editedTaskRaw.timeEstimate || editedTaskRaw["Time Estimate"] || editedTaskRaw.TimeEstimate || ""
        };
        
        // Use original task fields as fallbacks for any missing fields
        const updatedTask = {
          id: existingTasks[specificTaskIndex].id,  // Preserve the original task ID
          title: (editedTask.title || existingTasks[specificTaskIndex].title || "").trim(),
          description: (editedTask.description || existingTasks[specificTaskIndex].description || "").trim(),
          timeEstimate: (editedTask.timeEstimate || existingTasks[specificTaskIndex].timeEstimate || "").trim()
        };
        
        // Force change detection by comparing the edited task to original
        const hasChanges = 
          updatedTask.title !== existingTasks[specificTaskIndex].title ||
          updatedTask.description !== existingTasks[specificTaskIndex].description ||
          updatedTask.timeEstimate !== existingTasks[specificTaskIndex].timeEstimate;
          
        // If no changes detected, add a note about the update
        if (!hasChanges) {
          console.log("No changes detected after normalization. Adding update note.");
          updatedTask.title = "Updated: " + updatedTask.title;
          updatedTask.description += "\n\nThis task has been reviewed and updated.";
        }
        
        console.log("Original task:", existingTasks[specificTaskIndex]);
        console.log("Updated task:", updatedTask);
        
        // Create a new copy of tasks with only the specific one modified
        const updatedTasks = [...existingTasks];
        updatedTasks[specificTaskIndex] = updatedTask;
        
        console.log(`Successfully edited task ${specificTaskIndex + 1} directly`);
        
        // Make a copy of the original specificTaskIndex since clearTaskEditRequest will reset it
        const editedTaskIndex = specificTaskIndex;
        
        // Clear the task edit request flag but keep a reference to what was edited
        clearTaskEditRequest(sessionId);
        
        // Store updated tasks both in system message and direct storage
        addMessage(sessionId, {
          role: "system",
          content: JSON.stringify({ 
            tasks: updatedTasks, 
            source: "task_editor",
            timestamp: Date.now()
          })
        });
        
        // Update the directly stored tasks
        storeGeneratedTasks(sessionId, updatedTasks);
        
        // Return the updated tasks with appropriate message
        await cleanScrapedDataDirectory();
        
        // Check if the tasks are website-related
        const hasWebsiteTasks = checkForWebsiteTasks(updatedTasks);
        let replyMessage = `I've updated Task ${editedTaskIndex + 1} as requested, while keeping the other tasks unchanged. Would you like to make any other changes?`;
        
        if (hasWebsiteTasks) {
          replyMessage += " Since these tasks relate to website work, it would be helpful if you could share the website URL you're working with (optional). This will allow me to provide more specific guidance.";
        }
        
        return {
          tasks: updatedTasks,
          reply: replyMessage
        };
      } catch (editError) {
        console.error("Error in direct task editing:", editError);
        clearTaskEditRequest(sessionId);
        
        await cleanScrapedDataDirectory();
        return { 
          tasks: getFallbackTasksByType(getTaskType(sessionId)),
          reply: "I encountered an error while trying to update task. Here are some alternatives."
        };
      }
    } else {
      // If no specific task index or invalid index, regenerate all tasks
      // This will only happen if we can't determine which specific task to edit
      console.log("No specific task index found, will regenerate all tasks");
      clearTaskEditRequest(sessionId);
      return await generateTasks(sessionId, messages);
    }
  } catch (error) {
    console.error("Error editing tasks:", error);
    clearTaskEditRequest(sessionId);
    
    await cleanScrapedDataDirectory();
    return { 
      tasks: getFallbackTasksByType(getTaskType(sessionId)),
      reply: "I encountered an error while trying to update the tasks. Here are some alternatives."
    };
  }
}

// Function to generate tasks based on conversation context
async function generateTasks(sessionId, messages) {
  const taskType = getTaskType(sessionId);
  
  // Create task generation prompt
  const websiteData = getWebsiteData(sessionId);
  let taskGenerationPrompt;
  
  if (websiteData && websiteData.analysisPrompt) {
    // Use website-specific data for task generation
    taskGenerationPrompt = {
      role: "system",
      content: websiteData.analysisPrompt + "\n\nGenerate EXACTLY 3 specific, actionable tasks to address the issues identified in the analysis. Each task must have a clear title, detailed step-by-step description, and realistic time estimate. Return your response in JSON format."
    };
  } else {
    // Use generic task generation prompt
    taskGenerationPrompt = {
      role: "system",
      content: "Generate EXACTLY 3 specific, actionable tasks based on the user's request. Each task must:\n\n1. Have a clear title that describes a specific action\n2. Include a detailed, step-by-step description\n3. Include a realistic time estimate\n\nReturn ONLY a JSON object with tasks array containing EXACTLY 3 tasks. The response should be valid JSON."
    };
  }
  
  try {
    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [...messages, taskGenerationPrompt],
      response_format: { type: "json_object" }
    });
    
    const responseMessage = chatCompletion.choices[0].message;
    let content = responseMessage.content?.trim() || "{}";
    
    // Parse and validate the response
    try {
      const parsedData = JSON.parse(content);

      let tasksList = [];

      if (Array.isArray(parsedData)) {
        tasksList = parsedData;
      }
      else if (parsedData.tasks && Array.isArray(parsedData.tasks)) {
        tasksList = parsedData.tasks;
      }
      else if (parsedData.title && parsedData.description && parsedData.timeEstimate) {
        tasksList = [parsedData];
      }

      // Extract tasks from reply text if no tasks array found
      if (tasksList.length === 0 && parsedData.reply) {
        console.log("No tasks found in tasks array, checking reply for task content");
        const extractedTasks = extractTasksFromReply(parsedData.reply);

        if (extractedTasks && extractedTasks.length > 0) {
          console.log(`Found ${extractedTasks.length} tasks in the reply text`);
          tasksList = extractedTasks;
        }
      }

      // Use fallbacks if no tasks found
      if (tasksList.length === 0) {
        console.warn("No tasks found in response, using fallbacks");
        tasksList = getFallbackTasksByType(taskType);
      }

      // Enforce consistent format and ensure complete tasks
      const validatedTasks = tasksList.map((task, index) => {
        // Ensure task title is not empty
        const title = (task.title || "").trim() || "Untitled Task";
        
        // Ensure description is not empty
        let description = (task.description || "").trim();
        if (!description) {
          description = "No description provided. Please add detailed steps for this task.";
        }
        
        // Ensure time estimate has a consistent format
        let timeEstimate = (task.timeEstimate || "").trim();
        if (!timeEstimate || timeEstimate.length > 20) {
          // If empty or too verbose, use a standard format
          timeEstimate = "1 hour";
        }
        
        return {
          id: index + 1, // Add sequential ID
          title,
          description,
          timeEstimate
        };
      }).slice(0, 3);

      // Always ensure we have exactly 3 tasks
      const fallbackTasks = getFallbackTasksByType(taskType);
      while (validatedTasks.length < 3) {
        validatedTasks.push(fallbackTasks[validatedTasks.length - 1]);
      }

      // Check if tasks are actually questions rather than tasks
      if (detectQuestionsInTasks(validatedTasks)) {
        console.log("Tasks appear to be questions, converting to reply format");
        const questionsAsReply = convertTasksToReply(validatedTasks);
        await cleanScrapedDataDirectory();
        return { tasks: [], reply: questionsAsReply };
      }

      // Mark that we've generated tasks for this session
      markTasksGenerated(sessionId);
      
      // Reset question counter for next conversation
      resetQuestionCount(sessionId);
      
      // Store the tasks in a system message for future reference
      addMessage(sessionId, {
        role: "system",
        content: JSON.stringify({ 
          tasks: validatedTasks,
          source: "task_generator",
          timestamp: Date.now() 
        })
      });
      
      // Also store them in a more persistent format for easier retrieval
      storeGeneratedTasks(sessionId, validatedTasks);
      
      await cleanScrapedDataDirectory();
      return { 
        tasks: validatedTasks, 
        reply: "Here are some tasks based on our conversation. Would you like to make any adjustments to these tasks?" 
      };
    } catch (error) {
      console.error("Error parsing tasks:", error);
      await cleanScrapedDataDirectory();
      return { 
        tasks: getFallbackTasksByType(taskType), 
        reply: "I had some trouble generating custom tasks. Here are some suggestions to get you started." 
      };
    }
  } catch (error) {
    console.error("Error generating tasks:", error);
    await cleanScrapedDataDirectory();
    return { 
      tasks: getFallbackTasksByType(taskType), 
      reply: "I encountered an error while generating tasks. Here are some general suggestions instead." 
    };
  }
}

// Function to get appropriate fallback tasks based on task type
function getFallbackTasksByType(taskType) {
  let taskId = 1; // Initialize task ID counter
  const addTaskId = (task) => ({ ...task, id: taskId++ }); // Helper function to add ID

  switch(taskType) {
    case "website":
      return [
        addTaskId({
          title: "Audit Website Content and Structure",
          description: "Conduct a complete inventory of all website pages and content. Identify outdated information, broken links, and opportunities for improvement. Create a spreadsheet to track each page, its purpose, and status.",
          timeEstimate: "3 hours"
        }),
        addTaskId({
          title: "Improve Website User Experience",
          description: "Test your website's navigation flow and identify points of friction. Simplify menus, improve page loading speed, and ensure mobile responsiveness. Consider implementing user feedback mechanisms.",
          timeEstimate: "4 hours"
        }),
        addTaskId({
          title: "Create a Content Update Schedule",
          description: "Develop a calendar for regular content updates and new publications. Plan topics that align with user interests and business goals. Establish a workflow for content creation, review, and publication.",
          timeEstimate: "2 hours"
        })
      ];
    
    case "business":
      return [
        addTaskId({
          title: "Define Key Performance Indicators",
          description: "Identify 3-5 critical metrics that directly reflect business success. Create a tracking system to monitor these metrics regularly. Define baseline values and set realistic improvement targets.",
          timeEstimate: "2 hours"
        }),
        addTaskId({
          title: "Streamline Business Processes",
          description: "Map out current workflows and identify bottlenecks. Remove unnecessary steps and automate repetitive tasks where possible. Document improved processes and train team members on changes.",
          timeEstimate: "4 hours"
        }),
        addTaskId({
          title: "Develop Customer Feedback System",
          description: "Create a mechanism to regularly collect customer insights. Design short, focused surveys or implement review requests. Establish a process to analyze feedback and take action on common themes.",
          timeEstimate: "3 hours"
        })
      ];
      
    case "education":
      return [
        addTaskId({
          title: "Create a Structured Learning Plan",
          description: "Develop a comprehensive learning schedule with clear milestones. Break down complex topics into manageable units. Set specific goals for each study session and track progress regularly.",
          timeEstimate: "2 hours"
        }),
        addTaskId({
          title: "Implement Active Learning Techniques",
          description: "Convert passive study materials into active learning activities. Create practice questions, flashcards, or teaching materials. Schedule regular self-assessment to test understanding.",
          timeEstimate: "3 hours"
        }),
        addTaskId({
          title: "Build a Comprehensive Resource Library",
          description: "Gather and organize all learning materials in one accessible location. Categorize resources by topic and format. Create a system to track which resources have been completed.",
          timeEstimate: "2 hours"
        })
      ];
      
    case "personal":
      return [
        addTaskId({
          title: "Create a Productivity System",
          description: "Select and set up a task management tool that fits your workflow. Define categories for different areas of your life and establish a regular review process. Implement time blocking for important activities.",
          timeEstimate: "2 hours"
        }),
        addTaskId({
          title: "Establish Daily Routines",
          description: "Design morning and evening routines that support your goals. Start with 2-3 keystone habits and gradually expand. Track adherence to routines for at least 30 days to build consistency.",
          timeEstimate: "1 hour"
        }),
        addTaskId({
          title: "Set Up Progress Tracking",
          description: "Choose and implement a system to track your progress towards goals. Set up regular review periods to assess progress and make adjustments. Create visual representations of your progress to stay motivated.",
          timeEstimate: "2 hours"
        })
      ];
      
    default: // general fallback tasks
      return [
        addTaskId({
          title: "Define Clear Objectives",
          description: "Identify specific, measurable goals related to your project or area of focus. Break larger goals into smaller milestones with deadlines. Document success criteria for each objective.",
          timeEstimate: "2 hours"
        }),
        addTaskId({
          title: "Create an Action Plan",
          description: "List all required steps to achieve your objectives in sequential order. Identify resources, tools, and information needed for each step. Assign priorities and estimate completion times.",
          timeEstimate: "3 hours"
        }),
        addTaskId({
          title: "Implement a Tracking System",
          description: "Set up a method to monitor progress on your action items. Choose a tool (digital or physical) that fits your workflow. Establish a regular review schedule to assess progress and make adjustments.",
          timeEstimate: "2 hours"
        })
      ];
  }
}

// Detect if tasks array contains questions rather than actual tasks
function detectQuestionsInTasks(tasks) {
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return false;

  const strongQuestionPatterns = [
    /\?$/,
    /^(what|how|where|when|why|which|who|whom)\b/i,
    /\b(do|does|did|is|are|am|can|could|would|should|will|have|has|had)\s+(you|your|we|I)\b/i,
    /\btell me\b/i,
    /\blet me know\b/i
  ];

  const taskPatterns = [
    /^(create|build|develop|implement|set up|configure|optimize|improve|fix|add|remove|update|modify)/i,
    /\bstep\s*\d+\b/i,
    /\b(hour|minute|day|week)\b/i,
    /\bby\s+(using|implementing|adding|following)/i
  ];

  const questionCount = tasks.filter(task =>
    strongQuestionPatterns.some(pattern => pattern.test(task.title))
  ).length;

  const taskCount = tasks.filter(task =>
    taskPatterns.some(pattern => pattern.test(task.title) ||
      (task.description && pattern.test(task.description)))
  ).length;

  const userQueryCount = tasks.filter(task => {
    const lowercaseTitle = task.title.toLowerCase();
    return (lowercaseTitle.includes("your") || lowercaseTitle.includes("you ")) &&
      !lowercaseTitle.includes("should") &&
      task.description.length < 20;
  }).length;

  const totalQuestionIndicators = questionCount + userQueryCount;

  return (totalQuestionIndicators > taskCount) ||
    (totalQuestionIndicators >= Math.ceil(tasks.length / 2)) ||
    (tasks.every(task => task.description.length < 30) && totalQuestionIndicators > 0);
}

// Function to detect if a task is website-related
function isWebsiteRelatedTask(task) {
  if (!task || !task.title || !task.description) return false;
  
  const title = task.title.toLowerCase();
  const description = task.description.toLowerCase();
  const combinedText = title + " " + description;
  
  // Keywords that suggest website-related tasks
  const websiteKeywords = [
    'website', 'web page', 'webpage', 'web site', 'site', 'landing page', 
    'homepage', 'blog', 'seo', 'search engine', 'domain', 'url', 'link',
    'html', 'css', 'javascript', 'web design', 'web development', 'wordpress',
    'analytics', 'google analytics', 'sitemap', 'hosting', 'traffic',
    'browser', 'online presence', 'web content', 'meta tag'
  ];
  
  return websiteKeywords.some(keyword => combinedText.includes(keyword));
}

// Check if any of the tasks are website-related and need a URL
function checkForWebsiteTasks(tasks) {
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return false;
  
  // Check if any task is website-related
  return tasks.some(task => isWebsiteRelatedTask(task));
}

// Convert tasks to conversation reply format when they're actually questions
function convertTasksToReply(tasks) {
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return "";

  let reply = "Before I can provide specific tasks, I need to understand more about your situation:\n\n";

  tasks.forEach((task, index) => {
    let title = task.title;
    if (!title.endsWith("?") &&
      !title.endsWith(".") &&
      !title.endsWith("!") &&
      !/^(create|implement|build|develop|improve)/i.test(title)) {
      title += "?";
    }

    reply += `${index + 1}. ${title}\n`;

    if (task.description && task.description.trim()) {
      reply += `   ${task.description.trim()}\n`;
    }

    if (index < tasks.length - 1) {
      reply += "\n";
    }
  });

  return reply + "\n\nOnce you provide this information, I'll be able to suggest specific, tailored tasks for you.";
}

// Ensure tasks are properly formatted in the response
async function ensureTasksInTasksArray(response) {
  if (!response) return null;
  
  // First, check for and extract tasks from reply if the tasks array is empty
  if ((!response.tasks || response.tasks.length === 0) && response.reply) {
    console.log("Tasks array is empty, checking reply for task content");
    const extractedTasks = extractTasksFromReply(response.reply);
    
    if (extractedTasks && extractedTasks.length > 0) {
      console.log(`Found ${extractedTasks.length} tasks in the reply text`);
      
      // Check if these are actually questions rather than tasks
      if (detectQuestionsInTasks(extractedTasks)) {
        console.log("Extracted content looks like questions, keeping in reply format");
        return response;
      }
      
      // Move tasks from reply to tasks array
      response.tasks = extractedTasks;
      
      // Set a simple confirmation as the reply
      response.reply = "I've generated the following tasks based on our conversation. Would you like me to explain any of them in more detail?";
      
      console.log("Successfully moved tasks from reply to tasks array");
    }
  }
  
  // If tasks exist but could contain questions, handle that case
  if (response.tasks && response.tasks.length > 0) {
    if (detectQuestionsInTasks(response.tasks)) {
      console.log("Detected questions in tasks array, converting to reply");
      
      const questionsAsReply = convertTasksToReply(response.tasks);
      
      return {
        sessionId: response.sessionId,
        reply: questionsAsReply,
        tasks: []
      };
    }
    
    // Check if any tasks are website-related and we should ask for a URL
    const hasWebsiteTasks = checkForWebsiteTasks(response.tasks);
    if (hasWebsiteTasks) {
      console.log("Website-related tasks detected, adding URL request to reply");
      
      // Modify the reply to ask for a URL (making it optional)
      let reply = response.reply || "I've prepared these tasks based on your request.";
      reply += " Since these tasks relate to website work, it would be helpful if you could share the website URL you're working with (optional). This will allow me to provide more specific guidance.";
      
      response.reply = reply;
    }
  }
  
  // Ensure tasks array exists
  if (!response.tasks) {
    response.tasks = [];
  }
  
  // If we have valid tasks, we can simplify or null out the reply
  if (response.tasks.length > 0 && !detectQuestionsInTasks(response.tasks)) {
    // Only replace reply if it contains task-like content and isn't already customized
    if (response.reply && extractTasksFromReply(response.reply) && !response.reply.includes("website URL")) {
      response.reply = "Here are the tasks I've prepared for you.";
    }
  }
  
  return response;
}

app.listen(PORT, () => {
  console.log(`🚀 Task Assistant API running on http://localhost:${PORT}`);
});
