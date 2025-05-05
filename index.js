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
  clearTaskEditRequest,
  storeWebsiteData,
  getWebsiteData
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
    let message, sessionId;

    try {
      if (typeof req.body !== 'object') {
        return res.status(400).json({
          error: "Invalid request body format. Expected JSON object."
        });
      }

      message = req.body.message;
      sessionId = req.body.sessionId;

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
  if (hasGeneratedTasks(sessionId) && isTaskEditRequested(sessionId)) {
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
  // Get the specific task to edit (if any)
  const specificTaskIndex = getSpecificTaskToEdit(sessionId);
  
  // Prepare guidance for the model
  let editingGuidance;
  
  if (specificTaskIndex !== null) {
    editingGuidance = {
      role: "system",
      content: `The user wants to edit Task ${specificTaskIndex + 1}. Keep the other tasks unchanged. Generate an updated version of all three tasks, where only Task ${specificTaskIndex + 1} should be modified based on the user's feedback. Return all tasks in JSON format.`
    };
  } else {
    editingGuidance = {
      role: "system",
      content: "The user wants to edit the previously generated tasks. Generate updated versions of these tasks incorporating their feedback. Return tasks in JSON format."
    };
  }
  
  try {
    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [...messages, editingGuidance],
      response_format: { type: "json_object" }
    });
    
    const responseMessage = chatCompletion.choices[0].message;
    let content = responseMessage.content?.trim() || "{}";
    
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

      if (tasksList.length === 0 && parsedData.reply) {
        console.log("No tasks found in tasks array, checking reply for task content");
        const extractedTasks = extractTasksFromReply(parsedData.reply);

        if (extractedTasks && extractedTasks.length > 0) {
          console.log(`Found ${extractedTasks.length} tasks in the reply text`);
          tasksList = extractedTasks;
        }
      }

      if (tasksList.length === 0) {
        console.warn("No tasks found in response, using fallbacks");
        tasksList = getFallbackTasksByType(getTaskType(sessionId));
      }

      const validatedTasks = tasksList.map(task => ({
        title: task.title || "Untitled Task",
        description: task.description || "No description provided",
        timeEstimate: task.timeEstimate || "1 hour"
      })).slice(0, 3);

      while (validatedTasks.length < 3) {
        validatedTasks.push(getFallbackTasksByType(getTaskType(sessionId))[validatedTasks.length - 1]);
    }
    
      // Clear the task edit request flag
      clearTaskEditRequest(sessionId);
      
      let replyMessage;
      if (specificTaskIndex !== null) {
        replyMessage = `I've updated Task ${specificTaskIndex + 1} as requested. Would you like to make any other changes?`;
      } else {
        replyMessage = "I've updated the tasks based on your feedback. How do these look now?";
      }
      
      await cleanScrapedDataDirectory();
      return { 
        tasks: validatedTasks,
        reply: replyMessage
      };
      } catch (error) {
      console.error("Error parsing edited tasks:", error);
      clearTaskEditRequest(sessionId);
      
      await cleanScrapedDataDirectory();
      return { 
        tasks: getFallbackTasksByType(getTaskType(sessionId)),
        reply: "I had trouble updating the tasks. Here are some suggestions instead."
      };
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
      content: websiteData.analysisPrompt + "\n\nGenerate EXACTLY 3 specific, actionable tasks to address the issues identified in the analysis. Each task must have a clear title, detailed step-by-step description, and realistic time estimate."
    };
  } else {
    // Use generic task generation prompt
    taskGenerationPrompt = {
      role: "system",
      content: "Generate EXACTLY 3 specific, actionable tasks based on the user's request. Each task must:\n\n1. Have a clear title that describes a specific action\n2. Include a detailed, step-by-step description\n3. Include a realistic time estimate\n\nReturn ONLY a JSON object with tasks array."
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

      const validatedTasks = tasksList.map(task => ({
        title: task.title || "Untitled Task",
        description: task.description || "No description provided",
        timeEstimate: task.timeEstimate || "1 hour"
      })).slice(0, 3);

      while (validatedTasks.length < 3) {
        validatedTasks.push(getFallbackTasksByType(taskType)[validatedTasks.length - 1]);
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
      
      addMessage(sessionId, {
        role: "assistant",
        content: `Generated ${validatedTasks.length} tasks for ${taskType} focus.`
      });
      
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
  switch(taskType) {
    case "website":
      return [
        {
          title: "Audit Website Content and Structure",
          description: "Conduct a complete inventory of all website pages and content. Identify outdated information, broken links, and opportunities for improvement. Create a spreadsheet to track each page, its purpose, and status.",
          timeEstimate: "3 hours"
        },
        {
          title: "Improve Website User Experience",
          description: "Test your website's navigation flow and identify points of friction. Simplify menus, improve page loading speed, and ensure mobile responsiveness. Consider implementing user feedback mechanisms.",
          timeEstimate: "4 hours"
        },
        {
          title: "Create a Content Update Schedule",
          description: "Develop a calendar for regular content updates and new publications. Plan topics that align with user interests and business goals. Establish a workflow for content creation, review, and publication.",
          timeEstimate: "2 hours"
        }
      ];
    
    case "business":
      return [
        {
          title: "Define Key Performance Indicators",
          description: "Identify 3-5 critical metrics that directly reflect business success. Create a tracking system to monitor these metrics regularly. Define baseline values and set realistic improvement targets.",
          timeEstimate: "2 hours"
        },
        {
          title: "Streamline Business Processes",
          description: "Map out current workflows and identify bottlenecks. Remove unnecessary steps and automate repetitive tasks where possible. Document improved processes and train team members on changes.",
          timeEstimate: "4 hours"
        },
        {
          title: "Develop Customer Feedback System",
          description: "Create a mechanism to regularly collect customer insights. Design short, focused surveys or implement review requests. Establish a process to analyze feedback and take action on common themes.",
          timeEstimate: "3 hours"
        }
      ];
      
    case "education":
      return [
        {
          title: "Create a Structured Learning Plan",
          description: "Break down the subject into manageable topics and subtopics. Sequence them in a logical order with time estimates for each. Identify resources needed for each topic and set completion milestones.",
          timeEstimate: "2 hours"
        },
        {
          title: "Implement Active Learning Techniques",
          description: "Convert passive study materials into active learning activities. Create practice questions, flashcards, or teaching materials. Schedule regular self-assessment to test understanding.",
          timeEstimate: "3 hours"
        },
        {
          title: "Build a Comprehensive Resource Library",
          description: "Gather and organize all learning materials in one accessible location. Categorize resources by topic and format. Create a system to track which resources have been completed.",
          timeEstimate: "2 hours"
        }
      ];
      
    case "personal":
      return [
        {
          title: "Create a Productivity System",
          description: "Select and set up a task management tool that fits your workflow. Define categories for different areas of your life and establish a regular review process. Implement time blocking for important activities.",
          timeEstimate: "2 hours"
        },
        {
          title: "Establish Daily Routines",
          description: "Design morning and evening routines that support your goals. Start with 2-3 keystone habits and gradually expand. Track adherence to routines for at least 30 days to build consistency.",
          timeEstimate: "1 hour"
        },
        {
          title: "Set Up Progress Tracking",
          description: "Define measurable indicators for your personal goals. Create a simple dashboard or journal system to monitor these regularly. Schedule weekly reviews to assess progress and make adjustments.",
          timeEstimate: "2 hours"
        }
      ];
      
    default: // general fallback tasks
      return [
        {
          title: "Define Clear Objectives",
          description: "Identify specific, measurable goals related to your project or area of focus. Break larger goals into smaller milestones with deadlines. Document success criteria for each objective.",
          timeEstimate: "2 hours"
        },
        {
          title: "Create an Action Plan",
          description: "List all required steps to achieve your objectives in sequential order. Identify resources, tools, and information needed for each step. Assign priorities and estimate completion times.",
          timeEstimate: "3 hours"
        },
        {
          title: "Implement a Tracking System",
          description: "Set up a method to monitor progress on your action items. Choose a tool (digital or physical) that fits your workflow. Establish a regular review schedule to assess progress and make adjustments.",
          timeEstimate: "2 hours"
        }
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
  }
  
  // Ensure tasks array exists
  if (!response.tasks) {
    response.tasks = [];
  }
  
  // If we have valid tasks, we can simplify or null out the reply
  if (response.tasks.length > 0 && !detectQuestionsInTasks(response.tasks)) {
    // Only replace reply if it contains task-like content
    if (response.reply && extractTasksFromReply(response.reply)) {
      response.reply = "Here are the tasks I've prepared for you.";
    }
  }
  
  return response;
}

app.listen(PORT, () => {
  console.log(`🚀 Task Assistant API running on http://localhost:${PORT}`);
});
