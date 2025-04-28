// A simple in-memory storage for chat sessions
const sessions = new Map();

// Create a new session or get existing one
export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [
        {
          role: "system",
          content: "You are an AI assistant specializing in task creation for any domain. Your goal is to help users break down complex goals into actionable tasks. Follow this process:\n\n1) Ask 1-2 brief clarifying questions to understand the user's specific needs. Focus on their goals and challenges. Keep questions brief and direct.\n\n2) After gathering basic information, generate EXACTLY 3 specific, actionable tasks that directly address the user's goal.\n\n3) Each task must include: (a) A clear, specific title describing what needs to be done (b) A detailed description with step-by-step instructions (c) A realistic time estimate.\n\nMake all tasks immediately actionable, specific to the user's situation, and provide clear value."
        }
      ],
      taskType: null, // Will store task category based on conversation
      questionCount: 0, // Track how many questions have been asked
      hasEnoughContext: false, // Flag to indicate when ready for task generation
      tasksGenerated: false // Flag to indicate if tasks have been generated
    });
  }
  return sessions.get(sessionId);
}

// Add a message to the session
export function addMessage(sessionId, message) {
  const session = getSession(sessionId);
  
  // Validate message before adding to ensure no null content
  const validatedMessage = { ...message };
  
  // Ensure content is not null/undefined for roles that require content
  if ((message.role === "user" || message.role === "assistant" || message.role === "system") 
      && (message.content === null || message.content === undefined)) {
    validatedMessage.content = "";
  }
  
  // Ensure content is not null/undefined for tool messages
  if (message.role === "tool" && (message.content === null || message.content === undefined)) {
    validatedMessage.content = "";
  }
  
  // Attempt to detect task type from user messages if not already set
  if (session.taskType === null && message.role === "user") {
    const content = message.content.toLowerCase();
    
    // Check for different domains to categorize the task type
    if (content.includes("website") || content.includes("seo") || 
        content.includes("web") || content.includes("url") ||
        /https?:\/\/[^\s]+/.test(content)) {
      session.taskType = "website";
    } else if (content.includes("business") || content.includes("company") ||
               content.includes("startup") || content.includes("product") ||
               content.includes("market") || content.includes("customer")) {
      session.taskType = "business";
    } else if (content.includes("learn") || content.includes("study") ||
               content.includes("education") || content.includes("course")) {
      session.taskType = "education";
    } else if (content.includes("personal") || content.includes("life") ||
               content.includes("habit") || content.includes("goal")) {
      session.taskType = "personal";
    } else {
      session.taskType = "general";
    }
  }
  
  // Track assistant questions for conversational flow
  if (message.role === "assistant" && 
      (message.content.endsWith("?") || 
       message.content.includes("Could you") || 
       message.content.includes("Can you"))) {
    session.questionCount += 1;
  }
  
  // Check if we have enough context based on message count and question responses
  const userMessages = session.messages.filter(msg => msg.role === "user").length;
  if (userMessages >= 2 || session.questionCount >= 2) {
    session.hasEnoughContext = true;
  }
  
  session.messages.push(validatedMessage);
  return session;
}

// Get all messages for a session
export function getMessages(sessionId) {
  return getSession(sessionId).messages;
}

// Get the detected task type for a session
export function getTaskType(sessionId) {
  return getSession(sessionId).taskType;
}

// Check if we have enough context to generate tasks
export function isReadyForTasks(sessionId) {
  const session = getSession(sessionId);
  
  // Check if user explicitly requested tasks with very specific phrases
  const userMessages = session.messages.filter(msg => msg.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1]?.content?.toLowerCase() || "";
  
  const explicitTaskRequests = [
    "please generate tasks",
    "generate tasks now",
    "create tasks for me",
    "give me the tasks",
    "show me tasks now",
    "i want the tasks now",
    "finish the tasks",
    "generate the final tasks"
  ];
  
  const hasExplicitRequest = explicitTaskRequests.some(phrase => 
    lastUserMessage.includes(phrase)
  );
  
  // ONLY generate tasks if:
  // 1. User explicitly requested tasks with specific phrases
  // 2. OR we've had a sufficient conversation (3+ user messages AND 2+ questions)
  const minUserMessages = 2; // Reduce from 5 to 3 user messages
  const minQuestions = 2; // Reduce from 3 to 2 questions from assistant
  const hasSubstantialConversation = userMessages.length >= minUserMessages && session.questionCount >= minQuestions;
  
  return hasExplicitRequest || hasSubstantialConversation;
}

// Mark that tasks have been generated
export function markTasksGenerated(sessionId) {
  const session = getSession(sessionId);
  session.tasksGenerated = true;
}

// Check if tasks have been generated already
export function hasGeneratedTasks(sessionId) {
  return getSession(sessionId).tasksGenerated === true;
}

// Reset the question counter
export function resetQuestionCount(sessionId) {
  getSession(sessionId).questionCount = 0;
}

// Clear a session
export function clearSession(sessionId) {
  sessions.delete(sessionId);
} 