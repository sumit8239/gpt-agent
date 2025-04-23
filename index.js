import express from 'express';
import openai from './openaiClient.js';
import { analyzeWebsite } from './scrapping.js';
import { getMessages, addMessage, clearSession, getTaskType } from './chatSession.js';
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
    /(?:#{1,3}\s*)?(\d+)[:.]\s*([A-Z][^.]*(?:\.|$))/g
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
  const taskSections = reply.split(/(?:#{1,3}\s*)?Task\s*\d+[:\)]/i).slice(1);

  if (taskSections.length > 0) {
    const tasks = [];

    for (let i = 0; i < taskSections.length; i++) {
      const section = taskSections[i].trim();

      let title = '';
      let description = section;
      let timeEstimate = '1 hour'; // Default

      const titleMatch = section.match(/(?:\*\*([^*]+)\*\*|([^.:\n]+))/);
      if (titleMatch) {
        title = (titleMatch[1] || titleMatch[2]).trim();
        description = description.replace(titleMatch[0], '').trim();
      }

      const timePatterns = [
        /Time\s*Estimate\s*:\s*([^.\n]+)/i,
        /Estimated\s*Time\s*:\s*([^.\n]+)/i,
        /Duration\s*:\s*([^.\n]+)/i,
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

      description = description
        .replace(/\*\*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (!title || title.length > 50) {
        title = `Task ${i + 1}`;
      }

      tasks.push({ title, description, timeEstimate });
    }

    return tasks.length > 0 ? tasks : null;
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
  return process.env.VERCEL === '1' ? '/tmp' : path.join(process.cwd(), 'scraped_data');
}

// Function to analyze SEO issues
async function analyzeSEOIssues(url) {
  try {
    console.log(`Starting SEO analysis for ${url}`);
    
    const analysisData = await analyzeWebsite(url);
    
    if (analysisData.error) {
      throw new Error(`Failed to analyze website: ${analysisData.error}`);
    }

    const analysisPrompt = `Based on the following website analysis, identify specific SEO issues and create actionable tasks:

URL: ${url}
Title: ${analysisData.title || 'Not found'}
Meta Description: ${analysisData.metaData?.description || 'Not found'}
Meta Keywords: ${analysisData.metaData?.keywords || 'Not found'}

SEO Analysis:
- Title Length: ${analysisData.seoAnalysis?.titleLength || 0} characters
- Description Length: ${analysisData.seoAnalysis?.descriptionLength || 0} characters
- Has Canonical URL: ${analysisData.seoAnalysis?.hasCanonical ? 'Yes' : 'No'}
- Has Robots Meta: ${analysisData.seoAnalysis?.hasRobots ? 'Yes' : 'No'}
- Has Viewport Meta: ${analysisData.seoAnalysis?.hasViewport ? 'Yes' : 'No'}
- Has Open Graph Tags: ${analysisData.seoAnalysis?.hasOpenGraph ? 'Yes' : 'No'}
- Has Twitter Card Tags: ${analysisData.seoAnalysis?.hasTwitterCard ? 'Yes' : 'No'}

Content Analysis:
- H1 Tags: ${analysisData.bodyContent?.headings?.h1 || 0}
- H2 Tags: ${analysisData.bodyContent?.headings?.h2 || 0}
- Images: ${analysisData.bodyContent?.images || 0} (${analysisData.bodyContent?.imagesWithAlt || 0} with alt text)
- Internal Links: ${analysisData.bodyContent?.internalLinks || 0}
- External Links: ${analysisData.bodyContent?.externalLinks || 0}
- Word Count: ${analysisData.bodyContent?.wordCount || 0}

Please provide specific, actionable tasks in the following format as a JSON object:

{
  "tasks": [
    {
      "title": "Fix [Specific Issue]",
      "description": "Detailed steps to fix the issue, including specific code or content changes needed",
      "timeEstimate": "X hours",
      "priority": "High/Medium/Low",
      "impact": "Expected improvement in search rankings or user engagement"
    }
  ]
}`;

    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an expert SEO analyst. Analyze the provided website data and create specific, actionable tasks to improve the site's SEO. Each task should address a concrete issue found in the analysis. Provide your response in JSON format."
        },
        {
          role: "user",
          content: analysisPrompt
        }
      ],
      temperature: 0.7,
      max_tokens: 1000,
      response_format: { type: "json_object" }
    });

    let tasks = [];
    try {
      const parsedResponse = JSON.parse(gptResponse.choices[0].message.content);
      if (parsedResponse.tasks && Array.isArray(parsedResponse.tasks)) {
        tasks = parsedResponse.tasks;
      }
    } catch (error) {
      console.error('Error parsing GPT response:', error);
    }
    
    await cleanScrapedDataDirectory();
    return {
      success: true,
      tasks: tasks,
      rawData: analysisData
    };
  } catch (error) {
    console.error('Error in analyzeSEOIssues:', error);
    await cleanScrapedDataDirectory();
    return {
      success: false,
      error: error.message
    };
  }
}

// Function to clean up files in the scraped_data directory
async function cleanScrapedDataDirectory() {
  try {
    const scrapedDataDir = path.join(process.cwd(), 'scraped_data');
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

// Helper function to check if the conversation is ready for tasks
function isConversationTaskReady(userMessages) {
  if (!userMessages || userMessages.length === 0) return false;

  const urlPattern = /(https?:\/\/[^\s]+)/g;
  const hasURL = userMessages.some(msg => urlPattern.test(msg.content));

  const taskRequestPatterns = [
    /help me (with|to)/i,
    /need (help|assistance|tasks)/i,
    /generate (some )?(tasks|steps|plan)/i,
    /what (should|can) i do/i,
    /give me (a|some) (task|plan|step)/i,
    /how (can|should) i/i,
    /improve|optimize|enhance/i,
    /steps (to|for)/i
  ];

  const hasTaskRequest = userMessages.some(msg =>
    taskRequestPatterns.some(pattern => pattern.test(msg.content))
  );

  const hasMultipleMessages = userMessages.length >= 2;

  const hasDetailedMessage = userMessages.some(msg =>
    msg.content.split(/\s+/).length > 100
  );

  return userMessages.length >= 3 ||
    (hasURL && hasTaskRequest) ||
    (hasMultipleMessages && (hasTaskRequest || hasDetailedMessage));
}

// Helper function to process messages with GPT
async function processMessage(sessionId) {
  const allMessages = getMessages(sessionId);

  const systemMessage = allMessages.find(msg => msg.role === "system");
  const recentMessages = allMessages.filter(msg => msg.role !== "system").slice(-6);

  const messages = systemMessage ? [systemMessage, ...recentMessages] : recentMessages;

  const urlPattern = /(https?:\/\/[^\s]+)/g;
  const userMessages = allMessages.filter(msg => msg.role === "user");
  const mentionedUrls = [];

  userMessages.forEach(msg => {
    const matches = msg.content.match(urlPattern);
    if (matches) {
      mentionedUrls.push(...matches);
    }
  });

  const uniqueUrls = [...new Set(mentionedUrls)];

  const taskType = getTaskType(sessionId);

  if (!isConversationTaskReady(userMessages)) {
    let additionalInfo = "";
    if (taskType === "website" && uniqueUrls.length > 0) {
      try {
        const websiteData = await analyzeWebsite(uniqueUrls[0]);
        if (websiteData && !websiteData.error) {
          additionalInfo = `\nWebsite Analysis Results:\n- Title: ${websiteData.title || 'Not found'}\n- Description: ${websiteData.metaDescription || 'Not found'}\n- Content Summary: ${websiteData.snippet ? websiteData.snippet.substring(0, 200) + '...' : 'Not available'}\n- Performance: ${websiteData.performanceMetrics?.loadTime ? (websiteData.performanceMetrics.loadTime / 1000).toFixed(2) + 's load time' : 'Not measured'}\n- Mobile Responsive: ${websiteData.isMobileResponsive ? 'Yes' : 'No'}`;
        }
      } catch (error) {
        console.error("Error in preliminary website analysis:", error);
      }
    }

    const messagesForGPT = additionalInfo
      ? [...messages, { role: "system", content: additionalInfo }]
      : messages;

    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForGPT,
      tools: [
        {
          type: "function",
          function: {
            name: "search_web",
            description: "Search the web by analyzing a website",
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
          messages: getMessages(sessionId)
        });

        const finalAnswer = secondResponse.choices[0].message.content || "";

        addMessage(sessionId, { role: "assistant", content: finalAnswer });

        return { reply: finalAnswer, tasks: [] };
      } catch (error) {
        console.error("Error handling tool call:", error);
        const errorMessage = "I'm having trouble accessing search results right now. Let me help based on what I already know.";
        addMessage(sessionId, { role: "assistant", content: errorMessage });
        return { reply: errorMessage, tasks: [] };
      }
    }

    const content = responseMessage.content || "";
    addMessage(sessionId, {
      role: "assistant",
      content: content
    });

    return { reply: content, tasks: [] };
  }
  else {
    let researchResults = "";

    if (taskType === "website") {
      if (uniqueUrls.length > 0) {
        try {
          const seoAnalysis = await analyzeSEOIssues(uniqueUrls[0]);

          if (seoAnalysis.success) {
            let issuesList = "";

            if (seoAnalysis.issues?.length > 0) {
              issuesList = "Specific SEO issues found:\n\n";
              seoAnalysis.issues.forEach((issue, index) => {
                issuesList += `${index + 1}. ${issue.title}\n`;
                issuesList += `${issue.description}\n`;
                issuesList += `Time Estimate: ${issue.timeEstimate}\n\n`;
              });
            } else {
              issuesList = "No significant SEO issues were found in the head tags, but there may be other improvements possible.";
            }

            const siteInfo = `
Website: ${url}
Title: ${seoAnalysis.rawData.title || 'Not specified'}
Meta Description: ${seoAnalysis.rawData.metaData?.description || 'Not specified'}
Keywords: ${seoAnalysis.rawData.metaData?.keywords || 'Not specified'}

${issuesList}

When generating tasks, focus on fixing the specific issues mentioned above. 
Create detailed, actionable tasks with clear steps to resolve each issue.
Tasks should have specific titles that mention the exact problem being fixed.
`;

            researchResults = siteInfo;
          } else {
            researchResults = "Website analysis could not be completed. I'll provide general SEO recommendations.";
          }
        } catch (error) {
          console.error("Error in detailed SEO analysis:", error);
          researchResults = "Website analysis encountered an error. I'll provide general SEO recommendations.";
        }
      } else {
        const userQuery = userMessages.map(msg => msg.content).join(" ");
        try {
          researchResults = await webSearch(`website best practices for ${userQuery}`);
        } catch (error) {
          console.error("Error in general website search:", error);
          researchResults = "I'll provide recommendations based on web development best practices.";
        }
      }
    }
    else {
      const userTopics = userMessages.map(msg => msg.content).join(" ");
      try {
        researchResults = await webSearch(`best practices for ${userTopics}`);
      } catch (error) {
        console.error("Error in general topic search:", error);
        researchResults = "I'll provide recommendations based on best practices.";
      }
    }

    const messagesWithFormat = [...messages];

    if (researchResults) {
      messagesWithFormat.push({
        role: "system",
        content: `Research results to help formulate your tasks: ${researchResults}`
      });
    }

    messagesWithFormat.push({
      role: "system",
      content: "Generate EXACTLY 3 tasks based on our conversation and the website analysis provided. Focus on solving SPECIFIC PROBLEMS that were identified rather than general recommendations. Each task should:\n\n1. Have a title that clearly mentions the specific issue being fixed (e.g., 'Fix Missing Meta Description' rather than 'Improve SEO')\n2. Include a detailed, step-by-step description of how to implement the solution\n3. Mention specific tools, code snippets, or techniques needed\n4. Include a realistic time estimate\n\nYour response must be a valid JSON object with a single 'tasks' property containing an array of 3 task objects. Each task MUST have exactly these fields: 'title', 'description', and 'timeEstimate'. Format example: {\"tasks\":[{\"title\":\"Task 1\",\"description\":\"Description 1\",\"timeEstimate\":\"2 hours\"},{\"title\":\"Task 2\",\"description\":\"Description 2\",\"timeEstimate\":\"3 hours\"},{\"title\":\"Task 3\",\"description\":\"Description 3\",\"timeEstimate\":\"1 hour\"}]}"
    });

    const fallbackTasks = taskType === "website" ? [
      {
        title: "Improve Website SEO",
        description: "Optimize meta tags, headings, and content for better search engine visibility. Ensure title tags and meta descriptions are unique and descriptive for each page. Use heading tags (H1, H2, H3) in a hierarchical structure.",
        timeEstimate: "3 hours"
      },
      {
        title: "Enhance User Experience",
        description: "Improve site navigation and loading speed for better user retention. Compress images, minify CSS/JS, and implement lazy loading. Ensure the site is mobile-friendly and has an intuitive navigation structure.",
        timeEstimate: "4 hours"
      },
      {
        title: "Optimize Conversion Funnel",
        description: "Analyze and improve the user journey to increase sign-ups and conversions. Add clear calls-to-action, simplify forms, and reduce friction in the checkout/signup process. A/B test different elements to identify what works best.",
        timeEstimate: "5 hours"
      }
    ] : [
      {
        title: "Create a Productivity System",
        description: "Establish a personal productivity system using techniques like time blocking, the Pomodoro Technique, or Getting Things Done (GTD). Choose one method, set up the necessary tools (digital or analog), and schedule implementation for your daily routine.",
        timeEstimate: "2 hours"
      },
      {
        title: "Minimize Digital Distractions",
        description: "Reduce interruptions from devices and apps by configuring notification settings, using focus mode, and installing productivity extensions. Set up specific times to check email and messages rather than responding immediately.",
        timeEstimate: "1 hour"
      },
      {
        title: "Implement Regular Reviews",
        description: "Establish a system for daily, weekly and monthly reviews of your tasks and goals. Create templates for each review type, schedule them in your calendar, and use them to continuously refine your approach to work.",
        timeEstimate: "3 hours"
      }
    ];

    try {
      const chatPromise = openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messagesWithFormat,
        response_format: { type: "json_object" }
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), 15000)
      );

      const chatCompletion = await Promise.race([chatPromise, timeoutPromise]);

      const responseMessage = chatCompletion.choices[0].message;
      let content = responseMessage.content?.trim() || "{}";

      try {
        JSON.parse(content);
      } catch (parseError) {
        console.log("Received malformed JSON, attempting to fix");

        content = content.replace(/```json|```/g, '').trim();

        if (content.startsWith('[') && content.endsWith(']')) {
          content = `{"tasks": ${content}}`;
        }
      }

      addMessage(sessionId, {
        role: "assistant",
        content: content
      });

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
          tasksList = fallbackTasks;
        }

        const validatedTasks = tasksList.map(task => ({
          title: task.title || "Untitled Task",
          description: task.description || "No description provided",
          timeEstimate: task.timeEstimate || "1 hour"
        })).slice(0, 3);

        while (validatedTasks.length < 3) {
          validatedTasks.push(fallbackTasks[validatedTasks.length - 1]);
        }

        if (detectQuestionsInTasks(validatedTasks)) {
          console.log("Tasks appear to be questions, converting to reply format");
          const questionsAsReply = convertTasksToReply(validatedTasks);
          await cleanScrapedDataDirectory();
          return { tasks: [], reply: questionsAsReply };
        }

        await cleanScrapedDataDirectory();
        return { tasks: validatedTasks, reply: null };

      } catch (error) {
        console.error("Error parsing tasks JSON:", error);
        await cleanScrapedDataDirectory();
        return { tasks: fallbackTasks, reply: null };
      }
    } catch (error) {
      console.error("Error generating or parsing tasks:", error);
      await cleanScrapedDataDirectory();
      return { tasks: fallbackTasks, reply: null };
    }
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
  
  if (response.reply) {
    const extractedTasks = extractTasksFromReply(response.reply);
    
    if (extractedTasks && extractedTasks.length > 0) {
      if (detectQuestionsInTasks(extractedTasks)) {
        console.log("Extracted content looks like questions, keeping in reply format");
        return response;
      }
      
      console.log(`Extracted ${extractedTasks.length} tasks from reply`);
      // Clean up scraped_data directory after tasks are extracted
      await cleanScrapedDataDirectory();
      
      if (response.tasks && response.tasks.length > 0) {
        const remainingSlots = 3 - response.tasks.length;
        if (remainingSlots > 0) {
          response.tasks = [...response.tasks, ...extractedTasks.slice(0, remainingSlots)];
        }
      } else {
        response.tasks = extractedTasks.slice(0, 3);
      }
      
      response.reply = null;
    }
  }
  
  if (!response.tasks) {
    response.tasks = [];
  }
  
  if (response.tasks.length > 0 && !detectQuestionsInTasks(response.tasks)) {
    response.reply = null;
  }
  
  return response;
}

app.listen(PORT, () => {
  console.log(`🚀 Task Assistant API running on http://localhost:${PORT}`);
});
