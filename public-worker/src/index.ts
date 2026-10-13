export default {
  fetch(request:Request,env:{PUBLIC_ROOTS:Fetcher}):Promise<Response>{
    return env.PUBLIC_ROOTS.fetch(request);
  },
};
